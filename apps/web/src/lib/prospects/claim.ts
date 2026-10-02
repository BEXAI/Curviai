/**
 * Redeeming a prospect claim at signup (docs/phases/PHASE_18.md P18-04,
 * founder decision 11). A new account whose signup link carried
 * ?claim=<token> gets, at the email confirmation (or first Google sign in):
 * - attribution: signup_attributions.source = concierge, utm_campaign = the
 *   prospect label as a slug, claim_id = the claim's id (the raw token is
 *   not kept), and the same two values on its funnel.signup_confirmed row;
 * - the product: the listing photo the operator's pack was made from is
 *   copied into the new workspace's source prefix
 *   (ws/{ws}/src/claim-{claim id}.{ext}) and becomes a product with the same
 *   name, in one transaction with marking the claim redeemed (single use:
 *   only a claim with no claimed_at and no taken_down_at);
 * - then the welcome page continues to /app/new on that product.
 * No extra credits: the first pack is paid by the normal signup grant. The
 * same workspace asking again gets the same product; any other is refused.
 * Server only.
 */

import { createHash } from "node:crypto";
import {
  and,
  eq,
  packClaims,
  products,
  recordFunnelEvent,
  sourceMedia,
  sql,
  type Db,
} from "@curvi/db";
import { isWorkspaceSourceKey } from "@/lib/r2";
import { sniffImageType } from "@/lib/url-import/image";
import { isUuid } from "@/lib/validation/ids";
import { prospectCampaign } from "./store";
import { cleanClaimToken, hashClaimToken } from "./token";

export interface ClaimStorage {
  get(key: string): Promise<Buffer | null>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
}

export interface RedeemDeps {
  db: Db;
  storage: ClaimStorage;
  now: () => Date;
}

export type RedeemRefusal = "not_found" | "no_workspace" | "expired" | "taken_down" | "taken" | "missing_files";

export type RedeemResult =
  | { kind: "claimed" | "already"; productId: string; workspaceId: string }
  | { kind: "refused"; reason: RedeemRefusal };

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/tiff": "tiff",
};

/** The claimed photo's key in the new workspace's source prefix. */
export function claimedPhotoKey(workspaceId: string, claimId: string, extension: string): string {
  return `ws/${workspaceId}/src/claim-${claimId}.${extension}`;
}

async function productOfClaim(db: Db, workspaceId: string, claimId: string): Promise<string | null> {
  const media = await db.query.sourceMedia.findFirst({
    columns: { productId: true },
    where: (t, { and, eq, like }) => and(eq(t.workspaceId, workspaceId), like(t.r2Key, `ws/${workspaceId}/src/claim-${claimId}.%`)),
  });
  return media?.productId ?? null;
}

/** The listing photo the operator's pack was made from: the product's newest
 * image stored before the pack started, else its newest image. */
async function sourcePhoto(
  db: Db,
  job: { workspaceId: string; productId: string; createdAt: Date },
): Promise<{ r2Key: string } | null> {
  const media = await db.query.sourceMedia.findMany({
    columns: { r2Key: true, kind: true, createdAt: true },
    where: (t, { and, eq }) => and(eq(t.productId, job.productId), eq(t.workspaceId, job.workspaceId)),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit: 20,
  });
  const images = media.filter(
    (m) => (m.kind === "image" || m.kind === null) && isWorkspaceSourceKey(job.workspaceId, m.r2Key),
  );
  return images.find((m) => m.createdAt <= job.createdAt) ?? images[0] ?? null;
}

/** Points the new account's attribution at the outreach (P18-04): source
 * concierge, the label as utm_campaign, the claim's id instead of its token. */
async function attributeToOutreach(
  db: Db,
  input: { userId: string; workspaceId: string; claimId: string; label: string },
): Promise<void> {
  const campaign = prospectCampaign(input.label);
  await db.execute(sql`
    update signup_attributions
    set source = 'concierge', utm_campaign = ${campaign}, claim_id = ${input.claimId}
    where user_id = ${input.userId}::uuid
  `);
  await db.execute(sql`
    update events
    set props = props || jsonb_build_object('source', 'concierge', 'utm_campaign', ${campaign}::text)
    where workspace_id = ${input.workspaceId}::uuid and name = 'funnel.signup_confirmed'
  `);
}

export async function redeemProspectClaim(
  deps: RedeemDeps,
  input: { token: string; userId: string },
): Promise<RedeemResult> {
  const token = cleanClaimToken(input.token);
  if (!token || !isUuid(input.userId)) {
    return { kind: "refused", reason: "not_found" };
  }
  const membership = await deps.db.query.members.findFirst({
    where: (t, { and, eq }) => and(eq(t.userId, input.userId), eq(t.role, "owner")),
    orderBy: (t, { asc }) => [asc(t.createdAt), asc(t.workspaceId)],
  });
  if (!membership) {
    return { kind: "refused", reason: "no_workspace" };
  }
  const workspaceId = membership.workspaceId;
  const claim = await deps.db.query.packClaims.findFirst({
    where: (t, { eq }) => eq(t.tokenHash, hashClaimToken(token)),
  });
  if (!claim || claim.staffWorkspaceId === workspaceId) {
    // The operator's own workspace never claims its own pack.
    return { kind: "refused", reason: "not_found" };
  }
  if (claim.claimedAt) {
    const productId = claim.claimedByWorkspaceId === workspaceId ? await productOfClaim(deps.db, workspaceId, claim.id) : null;
    return productId ? { kind: "already", productId, workspaceId } : { kind: "refused", reason: "taken" };
  }
  if (claim.takenDownAt) {
    return { kind: "refused", reason: "taken_down" };
  }
  const now = deps.now();
  if (claim.expiresAt <= now) {
    return { kind: "refused", reason: "expired" };
  }

  const job = await deps.db.query.generationJobs.findFirst({
    columns: { workspaceId: true, productId: true, createdAt: true },
    where: (t, { and, eq }) => and(eq(t.id, claim.jobId), eq(t.workspaceId, claim.staffWorkspaceId)),
  });
  const photo = job ? await sourcePhoto(deps.db, job) : null;
  const bytes = photo ? await deps.storage.get(photo.r2Key) : null;
  const contentType = bytes ? sniffImageType(bytes) : null;
  const extension = contentType ? EXTENSIONS[contentType] : undefined;
  if (!job || !bytes || bytes.length === 0 || !contentType || !extension) {
    return { kind: "refused", reason: "missing_files" };
  }
  const staffProduct = await deps.db.query.products.findFirst({
    columns: { title: true },
    where: (t, { and, eq }) => and(eq(t.id, job.productId), eq(t.workspaceId, claim.staffWorkspaceId)),
  });
  const key = claimedPhotoKey(workspaceId, claim.id, extension);
  await deps.storage.put(key, bytes, contentType);

  const productId = await deps.db.transaction(async (tx) => {
    const marked = await tx
      .update(packClaims)
      .set({ claimedByWorkspaceId: workspaceId, claimedAt: now })
      .where(and(eq(packClaims.id, claim.id), sql`${packClaims.claimedAt} is null`, sql`${packClaims.takenDownAt} is null`))
      .returning({ id: packClaims.id });
    if (marked.length === 0) {
      return null;
    }
    const [product] = await tx
      .insert(products)
      .values({ workspaceId, title: (staffProduct?.title ?? claim.prospectLabel).slice(0, 120), mode: "listing" })
      .returning({ id: products.id });
    await tx
      .insert(sourceMedia)
      .values({
        workspaceId,
        productId: product.id,
        r2Key: key,
        kind: "image",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })
      .onConflictDoNothing();
    return product.id;
  });
  if (!productId) {
    // Another request redeemed or took it down between the read and the update.
    const again = await productOfClaim(deps.db, workspaceId, claim.id);
    return again ? { kind: "already", productId: again, workspaceId } : { kind: "refused", reason: "taken" };
  }
  try {
    await attributeToOutreach(deps.db, { userId: input.userId, workspaceId, claimId: claim.id, label: claim.prospectLabel });
  } catch (err) {
    console.error("[prospects] could not attribute a claimed signup", err instanceof Error ? err.message : err);
  }
  await recordFunnelEvent(deps.db, {
    workspaceId,
    name: "claim_redeemed",
    props: { campaign: prospectCampaign(claim.prospectLabel) },
  });
  return { kind: "claimed", productId, workspaceId };
}

/** redeemProspectClaim for the auth callback: never throws, null on
 * anything but a claim (the signup goes on as if there were no claim). */
export async function redeemProspectClaimSafely(
  deps: RedeemDeps,
  input: { token: string; userId: string },
): Promise<{ productId: string } | null> {
  try {
    const result = await redeemProspectClaim(deps, input);
    if (result.kind === "refused") {
      console.warn(`[prospects] claim refused: ${result.reason}`);
      return null;
    }
    return { productId: result.productId };
  } catch (err) {
    console.error("[prospects] claim failed", err instanceof Error ? err.message : err);
    return null;
  }
}
