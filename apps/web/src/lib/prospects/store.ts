/**
 * Prospect packs and their claims over the owner connection
 * (docs/phases/PHASE_18.md P18-04). pack_claims is a platform table with no
 * client access; every function here scopes by hand: operator reads and
 * writes by the operator's own workspace, public reads by the sha256 of the
 * claim token. Only the operator routes (gated by isOperator) and the share
 * page, the takedown route and the auth callback call it. Server only.
 */

import {
  and,
  eq,
  galleryItems,
  packClaims,
  recordFunnelEvent,
  shareLinks,
  sql,
  type Db,
  type PackClaim,
} from "@curvi/db";
import { prospectClaims } from "@curvi/pipeline/seed";
import { isUuid } from "@/lib/validation/ids";
import { derivedClaimToken, hashClaimToken, newClaimToken } from "./token";

const DAY_MS = 24 * 60 * 60 * 1000;

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] } | null)?.rows ?? [])) as T[];
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** When a claim link made now stops working. */
export function claimExpiry(now: Date): Date {
  return new Date(now.getTime() + prospectClaims.lifetimeDays * DAY_MS);
}

/** The prospect label as stored: one line, trimmed, at most 80 characters. */
export function cleanProspectLabel(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return value.length > 0 && value.length <= 80 ? value : null;
}

/** The label as a utm_campaign value: lower case letters, digits and
 * single hyphens, at most 100 characters ("Juniper Candles" is
 * "juniper-candles"). */
export function prospectCampaign(label: string): string | null {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : null;
}

// ---------------------------------------------------------------------------
// Operator side.
// ---------------------------------------------------------------------------

export type ProspectState = "making" | "ready" | "failed" | "claimed" | "taken_down" | "expired";

export interface ProspectRow {
  id: string;
  jobId: string;
  label: string;
  productTitle: string;
  productSourceUrl: string | null;
  jobStatus: string;
  /** The share page's slug, once one exists (published or not). */
  shareSlug: string | null;
  sharePublished: boolean;
  shareViews: number;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  takenDownAt: string | null;
  state: ProspectState;
}

const FAILED_JOB_STATES = new Set(["failed", "canceled"]);

export function prospectState(
  row: { jobStatus: string; claimedAt: string | null; takenDownAt: string | null; expiresAt: string },
  now: Date,
): ProspectState {
  if (row.takenDownAt) return "taken_down";
  if (row.claimedAt) return "claimed";
  if (FAILED_JOB_STATES.has(row.jobStatus)) return "failed";
  if (row.jobStatus !== "done") return "making";
  if (new Date(row.expiresAt).getTime() <= now.getTime()) return "expired";
  return "ready";
}

/**
 * Records a prospect pack the operator just started. The claim gets a token
 * no one ever sees (only its hash is kept), so no link works until the
 * operator makes one with issueClaimLink. A second call for the same pack
 * (a replayed create) returns the first row.
 */
export async function insertProspectClaim(
  db: Db,
  input: { jobId: string; staffWorkspaceId: string; label: string; productSourceUrl: string | null; now: Date },
): Promise<{ id: string; created: boolean }> {
  const inserted = await db
    .insert(packClaims)
    .values({
      tokenHash: hashClaimToken(newClaimToken()),
      jobId: input.jobId,
      staffWorkspaceId: input.staffWorkspaceId,
      prospectLabel: input.label,
      productSourceUrl: input.productSourceUrl,
      createdAt: input.now,
      expiresAt: claimExpiry(input.now),
    })
    .onConflictDoNothing({ target: packClaims.jobId })
    .returning({ id: packClaims.id });
  if (inserted.length > 0) {
    return { id: inserted[0].id, created: true };
  }
  const existing = await db.query.packClaims.findFirst({
    columns: { id: true },
    where: (t, { and, eq }) => and(eq(t.jobId, input.jobId), eq(t.staffWorkspaceId, input.staffWorkspaceId)),
  });
  if (!existing) {
    throw new Error("A prospect claim for this pack belongs to another workspace.");
  }
  return { id: existing.id, created: false };
}

/** The operator's prospect packs, newest first, with each pack's state. */
export async function listProspects(db: Db, staffWorkspaceId: string, now: Date = new Date()): Promise<ProspectRow[]> {
  if (!isUuid(staffWorkspaceId)) {
    return [];
  }
  const rows = rowsOf<{
    id: string;
    job_id: string;
    prospect_label: string;
    product_source_url: string | null;
    created_at: string | Date;
    expires_at: string | Date;
    claimed_at: string | Date | null;
    taken_down_at: string | Date | null;
    job_status: string;
    product_title: string | null;
    share_slug: string | null;
    share_public: boolean | null;
    share_views: number | null;
  }>(
    await db.execute(sql`
      select c.id, c.job_id, c.prospect_label, c.product_source_url, c.created_at, c.expires_at,
             c.claimed_at, c.taken_down_at, j.status as job_status, p.title as product_title,
             s.slug as share_slug, s.public as share_public, s.views as share_views
      from pack_claims c
      join generation_jobs j on j.id = c.job_id and j.workspace_id = c.staff_workspace_id
      left join products p on p.id = j.product_id and p.workspace_id = j.workspace_id
      left join share_links s on s.job_id = c.job_id and s.workspace_id = c.staff_workspace_id
      where c.staff_workspace_id = ${staffWorkspaceId}::uuid
      order by c.created_at desc
      limit ${prospectClaims.listLimit}
    `),
  );
  return rows.map((row) => {
    const base = {
      id: String(row.id),
      jobId: String(row.job_id),
      label: row.prospect_label,
      productTitle: row.product_title ?? row.prospect_label,
      productSourceUrl: row.product_source_url,
      jobStatus: row.job_status,
      shareSlug: row.share_slug,
      sharePublished: row.share_public === true,
      shareViews: Number(row.share_views ?? 0),
      createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
      expiresAt: iso(row.expires_at) ?? new Date(0).toISOString(),
      claimedAt: iso(row.claimed_at),
      takenDownAt: iso(row.taken_down_at),
    };
    return { ...base, state: prospectState(base, now) };
  });
}

export type IssueLinkResult =
  | { ok: true; token: string; expiresAt: Date; claim: PackClaim }
  | { ok: false; reason: "not_found" | "claimed" | "taken_down" };

/**
 * Makes a fresh claim link for one of the operator's prospect packs: a new
 * token replaces the old hash (the old link stops working) and the link
 * works for prospectClaims.lifetimeDays from now. A claimed or taken down
 * pack gets no new link. With the link secret the token is derived from the
 * claim and its expiry (./token.ts), so currentClaimLink can show it again;
 * the expiry moves on by a millisecond when that would give the token the
 * claim already has, so a new link always replaces the old one.
 */
export async function issueClaimLink(
  db: Db,
  input: { claimId: string; staffWorkspaceId: string; now: Date; secret?: string | null },
): Promise<IssueLinkResult> {
  if (!isUuid(input.claimId) || !isUuid(input.staffWorkspaceId)) {
    return { ok: false, reason: "not_found" };
  }
  let expiresAt = claimExpiry(input.now);
  let token = derivedClaimToken(input.claimId, expiresAt, input.secret);
  if (token) {
    const current = await db.query.packClaims.findFirst({
      columns: { tokenHash: true },
      where: (t, { and, eq }) => and(eq(t.id, input.claimId), eq(t.staffWorkspaceId, input.staffWorkspaceId)),
    });
    if (current && current.tokenHash === hashClaimToken(token)) {
      expiresAt = new Date(expiresAt.getTime() + 1);
      token = derivedClaimToken(input.claimId, expiresAt, input.secret);
    }
  }
  token ??= newClaimToken();
  const [claim] = await db
    .update(packClaims)
    .set({ tokenHash: hashClaimToken(token), expiresAt })
    .where(
      and(
        eq(packClaims.id, input.claimId),
        eq(packClaims.staffWorkspaceId, input.staffWorkspaceId),
        sql`${packClaims.claimedAt} is null`,
        sql`${packClaims.takenDownAt} is null`,
      ),
    )
    .returning();
  if (claim) {
    return { ok: true, token, expiresAt, claim };
  }
  const existing = await db.query.packClaims.findFirst({
    where: (t, { and, eq }) => and(eq(t.id, input.claimId), eq(t.staffWorkspaceId, input.staffWorkspaceId)),
  });
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }
  return { ok: false, reason: existing.takenDownAt ? "taken_down" : "claimed" };
}

/**
 * The live claim link token of one of the operator's prospect packs, for
 * the outreach kit, without replacing it: the token issueClaimLink derived
 * from the claim and its expiry, when that still matches the stored hash
 * and the link is neither claimed, taken down nor expired. Null otherwise,
 * and always null without the link secret.
 */
export async function currentClaimLink(
  db: Db,
  input: { claimId: string; staffWorkspaceId: string; now: Date; secret?: string | null },
): Promise<{ token: string; expiresAt: Date } | null> {
  if (!isUuid(input.claimId) || !isUuid(input.staffWorkspaceId)) {
    return null;
  }
  const claim = await db.query.packClaims.findFirst({
    where: (t, { and, eq }) => and(eq(t.id, input.claimId), eq(t.staffWorkspaceId, input.staffWorkspaceId)),
  });
  if (!claim || claim.claimedAt || claim.takenDownAt || claim.expiresAt.getTime() <= input.now.getTime()) {
    return null;
  }
  const token = derivedClaimToken(claim.id, claim.expiresAt, input.secret);
  return token && hashClaimToken(token) === claim.tokenHash ? { token, expiresAt: claim.expiresAt } : null;
}

/** True when the job is a prospect pack (P18-04): its share page must stay
 * out of the gallery, whatever the share panel asks. */
export async function isProspectJob(db: Pick<Db, "query">, jobId: string): Promise<boolean> {
  if (!isUuid(jobId)) {
    return false;
  }
  const claim = await db.query.packClaims.findFirst({ columns: { id: true }, where: (t, { eq }) => eq(t.jobId, jobId) });
  return claim !== undefined;
}

// ---------------------------------------------------------------------------
// Public side: the share page and the takedown.
// ---------------------------------------------------------------------------

export interface ProspectShareView {
  /** The store name the operator typed. */
  store: string;
  /** The token, when it is this page's live claim link: the page offers
   * "Make it yours" with it. Null otherwise. */
  claimToken: string | null;
  /** The token, when it matches this page's claim (claimed or expired
   * included): the page offers the takedown with it. */
  takedownToken: string | null;
}

/**
 * The prospect side of a public share page, or null when the page is not a
 * live prospect pack. Read by slug, so the page never learns an id.
 */
export async function prospectViewForSlug(
  db: Db,
  input: { slug: string; token: string | null; now: Date },
): Promise<ProspectShareView | null> {
  const rows = rowsOf<{
    prospect_label: string;
    token_hash: string;
    expires_at: string | Date;
    claimed_at: string | Date | null;
    taken_down_at: string | Date | null;
  }>(
    await db.execute(sql`
      select c.prospect_label, c.token_hash, c.expires_at, c.claimed_at, c.taken_down_at
      from share_links s
      join pack_claims c on c.job_id = s.job_id and c.staff_workspace_id = s.workspace_id
      where s.slug = ${input.slug} and s.public
      limit 1
    `),
  );
  const claim = rows[0];
  if (!claim || claim.taken_down_at) {
    return null;
  }
  const matches = input.token !== null && hashClaimToken(input.token) === claim.token_hash;
  const live = matches && !claim.claimed_at && new Date(claim.expires_at).getTime() > input.now.getTime();
  return {
    store: claim.prospect_label,
    claimToken: live ? input.token : null,
    takedownToken: matches ? input.token : null,
  };
}

export type TakedownOutcome = "taken_down" | "already" | "not_found";

/**
 * Takes a prospect's page down for whoever holds its claim link: the share
 * page goes private (and out of the gallery), the claim is marked taken
 * down and can no longer be redeemed, and funnel.claim_taken_down is
 * written to the operator's workspace. The founder also adds the contact
 * to the outreach tool's do not contact list (docs/marketing.md).
 */
export async function takeDownByToken(db: Db, input: { token: string; now: Date }): Promise<TakedownOutcome> {
  const claim = await db.query.packClaims.findFirst({
    where: (t, { eq }) => eq(t.tokenHash, hashClaimToken(input.token)),
  });
  if (!claim) {
    return "not_found";
  }
  if (claim.takenDownAt) {
    return "already";
  }
  const took = await db.transaction(async (tx) => {
    const marked = await tx
      .update(packClaims)
      .set({ takenDownAt: input.now })
      .where(and(eq(packClaims.id, claim.id), sql`${packClaims.takenDownAt} is null`))
      .returning({ id: packClaims.id });
    if (marked.length === 0) {
      return false;
    }
    const shares = await tx
      .update(shareLinks)
      .set({ isPublic: false, updatedAt: input.now })
      .where(and(eq(shareLinks.jobId, claim.jobId), eq(shareLinks.workspaceId, claim.staffWorkspaceId)))
      .returning({ slug: shareLinks.slug });
    for (const share of shares) {
      await tx
        .update(galleryItems)
        .set({ published: false })
        .where(and(eq(galleryItems.shareSlug, share.slug), eq(galleryItems.workspaceId, claim.staffWorkspaceId)));
    }
    return true;
  });
  if (!took) {
    return "already";
  }
  await recordFunnelEvent(db, {
    workspaceId: claim.staffWorkspaceId,
    name: "claim_taken_down",
    props: { claimed: claim.claimedAt !== null },
  });
  return "taken_down";
}
