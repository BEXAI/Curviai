import { assertSourceKeysAvailable, SourceUnavailableError } from "@/lib/trust/source-retention";
/**
 * The claim at signup (docs/phases/PHASE_18.md P18-12): a new account whose
 * signup link carried ?preview=<id> gets that photo as its first product.
 * At the email confirmation (or first Google sign in) the auth callback:
 * - copies the stored original into the workspace's source prefix
 *   (ws/{ws}/src/preview-{id}.{ext}), so the pack runs on exactly those bytes;
 * - copies the preview's cutout to the key the live runtime reads its
 *   cached cutout from (claimedCutoutCacheKey), so the first pack pays for
 *   no second cutout;
 * - in one transaction marks the preview claimed (single use: only a row
 *   still 'done' can be claimed) and creates the product with that photo;
 * - then opens /app/new on that product.
 * A second claim by the same workspace answers with the same product; any
 * other workspace is refused. Server only.
 */

import { createHash } from "node:crypto";
import {
  and,
  eq,
  freePreviews,
  products,
  recordFunnelEvent,
  sourceMedia,
  sql,
  type Db,
} from "@curvi/db";
import { isUuid } from "@/lib/validation/ids";
import {
  contentTypeOf,
  extensionOf,
  previewCutoutKey,
  previewOriginalKey,
  type PreviewStorage,
  type StoredFormat,
} from "./service";

/** The product a claimed preview becomes; the seller renames it on the form. */
export const PREVIEW_PRODUCT_TITLE = "Product from your free preview";

export interface ClaimDeps {
  db: Db;
  storage: PreviewStorage;
  now: () => Date;
  /** The live runtime's cached cutout key for these source bytes. */
  cacheKeyFor?: (workspaceId: string, sourceBytes: Buffer) => Promise<string>;
}

export type ClaimRefusal = "not_found" | "no_workspace" | "not_ready" | "expired" | "taken" | "missing_files";

export type ClaimResult =
  | { kind: "claimed" | "already"; productId: string; workspaceId: string }
  | { kind: "refused"; reason: ClaimRefusal };

async function defaultCacheKeyFor(workspaceId: string, sourceBytes: Buffer): Promise<string> {
  const { claimedCutoutCacheKey } = await import("@curvi/trigger/free-preview");
  return claimedCutoutCacheKey(workspaceId, sourceBytes);
}

/** The claimed photo's key in the workspace's source prefix. */
export function claimedSourceKey(workspaceId: string, previewId: string, format: StoredFormat): string {
  return `ws/${workspaceId}/src/preview-${previewId}.${extensionOf(format)}`;
}

function storedFormat(value: string | null): StoredFormat | null {
  return value === "jpeg" || value === "png" || value === "webp" ? value : null;
}

async function productOfClaim(db: Db, workspaceId: string, sourceKey: string): Promise<string | null> {
  const media = await db.query.sourceMedia.findFirst({
    columns: { productId: true },
    where: (t, { and, eq }) => and(eq(t.workspaceId, workspaceId), eq(t.r2Key, sourceKey)),
  });
  return media?.productId ?? null;
}

export async function claimFreePreview(deps: ClaimDeps, input: { previewId: string; userId: string }): Promise<ClaimResult> {
  if (!isUuid(input.previewId) || !isUuid(input.userId)) {
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
  const row = await deps.db.query.freePreviews.findFirst({ where: (t, { eq }) => eq(t.id, input.previewId) });
  const format = storedFormat(row?.sourceFormat ?? null);
  if (!row || !format) {
    return { kind: "refused", reason: "not_found" };
  }
  const sourceKey = claimedSourceKey(workspaceId, row.id, format);
  if (row.status === "claimed") {
    const productId = row.claimedWorkspaceId === workspaceId ? await productOfClaim(deps.db, workspaceId, sourceKey) : null;
    return productId ? { kind: "already", productId, workspaceId } : { kind: "refused", reason: "taken" };
  }
  if (row.status !== "done") {
    return { kind: "refused", reason: "not_ready" };
  }
  const now = deps.now();
  if (row.expiresAt <= now) {
    return { kind: "refused", reason: "expired" };
  }

  const original = await deps.storage.get(previewOriginalKey(row.id, format));
  if (!original || original.length === 0) {
    return { kind: "refused", reason: "missing_files" };
  }
  await deps.storage.put(sourceKey, original, contentTypeOf(format));
  const cutout = await deps.storage.get(previewCutoutKey(row.id));
  if (cutout && cutout.length > 0) {
    const cacheKey = await (deps.cacheKeyFor ?? defaultCacheKeyFor)(workspaceId, original);
    await deps.storage.put(cacheKey, cutout, "image/png");
  }

  const productId = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from workspaces where id = ${workspaceId}::uuid for update`);
    await assertSourceKeysAvailable(tx, workspaceId, [sourceKey]);
    const claimed = await tx
      .update(freePreviews)
      .set({ status: "claimed", claimedWorkspaceId: workspaceId, claimedAt: now })
      .where(and(eq(freePreviews.id, row.id), eq(freePreviews.status, "done")))
      .returning({ id: freePreviews.id });
    if (claimed.length === 0) {
      return null;
    }
    const [product] = await tx
      .insert(products)
      .values({ workspaceId, title: PREVIEW_PRODUCT_TITLE, mode: "listing" })
      .returning({ id: products.id });
    await tx
      .insert(sourceMedia)
      .values({
        workspaceId,
        productId: product.id,
        r2Key: sourceKey,
        kind: "image",
        sha256: createHash("sha256").update(original).digest("hex"),
      })
      .onConflictDoNothing();
    return product.id;
  }).catch((err: unknown) => {
    if (err instanceof SourceUnavailableError) return false as const;
    throw err;
  });
  if (productId === false) return { kind: "refused", reason: "missing_files" };
  if (!productId) {
    // Another request claimed it between the read and the update.
    const again = await productOfClaim(deps.db, workspaceId, sourceKey);
    return again ? { kind: "already", productId: again, workspaceId } : { kind: "refused", reason: "taken" };
  }
  await recordFunnelEvent(deps.db, { workspaceId, name: "preview_claimed", props: { from: "preview" } });
  return { kind: "claimed", productId, workspaceId };
}

/** claimFreePreview for the auth callback: never throws, null on anything
 * but a claim (the signup goes on as if there were no preview). */
export async function claimFreePreviewSafely(
  deps: ClaimDeps,
  input: { previewId: string; userId: string },
): Promise<{ productId: string } | null> {
  try {
    const result = await claimFreePreview(deps, input);
    if (result.kind === "refused") {
      console.warn(`[free-preview] claim of ${input.previewId} refused: ${result.reason}`);
      return null;
    }
    return { productId: result.productId };
  } catch (err) {
    console.error(`[free-preview] claim of ${input.previewId} failed`, err);
    return null;
  }
}
