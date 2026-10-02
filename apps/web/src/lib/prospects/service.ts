/**
 * The operator's prospect pack actions (docs/phases/PHASE_18.md P18-04):
 * make a pack through the normal createJob path (every cap, rule and charge
 * applies, paid from the operator's own credits), record its claim, publish
 * its share page link only with the measured checks on once the pack is
 * done (founder decision 9), and make the claim link with its outreach kit.
 * Callers have already checked isOperator (./operator.ts). Server only.
 */

import { z } from "zod";
import { recordFunnelEvent } from "@curvi/db";
import { channelChoices } from "@curvi/pipeline/seed";
import { hasSpec } from "@curvi/specs";
import { isWorkspaceSourceKey } from "@/lib/r2";
import type { CreateJobResult } from "@/lib/services/types";
import { canPublishShares, type ShareStore } from "@/lib/shares/types";
import { IMPORT_NOTES_MAX, IMPORT_TITLE_MAX } from "@/lib/url-import/types";
import { buildOutreachKit, type KitDeps, type OutreachKit } from "./kit";
import type { OperatorContext } from "./operator";
import {
  cleanProspectLabel,
  currentClaimLink,
  insertProspectClaim,
  issueClaimLink,
  listProspects,
  type ProspectRow,
} from "./store";

const CHANNEL_VALUES = channelChoices.map((choice) => choice.value) as [string, ...string[]];

export const CreateProspectRequest = z.object({
  store: z.string().max(200),
  productUrl: z.string().trim().max(2048).optional(),
  title: z.string().trim().max(IMPORT_TITLE_MAX).optional(),
  note: z.string().trim().max(IMPORT_NOTES_MAX).optional(),
  channels: z.array(z.enum(CHANNEL_VALUES)).min(1).max(CHANNEL_VALUES.length),
  upload: z.object({
    key: z.string().min(1).max(512),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    kind: z.literal("image"),
  }),
  idempotencyKey: z.string().min(8).max(200),
});

export type CreateProspectInput = z.infer<typeof CreateProspectRequest>;

/** The registry specs a set of channel choices stands for. */
export function specsForChannels(values: readonly string[]): string[] {
  const specs = channelChoices.filter((choice) => values.includes(choice.value)).flatMap((choice) => choice.specs);
  return [...new Set(specs)].filter((spec) => hasSpec(spec));
}

export type CreateProspectOutcome =
  | { ok: true; created: boolean; prospect: ProspectRow | null; jobId: string }
  | { ok: false; status: number; error: string; reason: string };

const REJECTED_STATUS: Record<Extract<CreateJobResult, { outcome: "rejected" }>["reason"], number> = {
  maintenance: 503,
  workspace_day_cap: 429,
  empty_plan: 422,
  unknown_product: 404,
  role_forbidden: 403,
  needs_photo: 400,
  no_media: 400,
  insufficient_credits: 402,
  upgrade_required: 402,
  feature_unavailable: 422,
  unavailable: 503,
  mode_unavailable: 400,
  invalid_upload: 422,
  invalid_options: 400,
  // Only an assistant's pack names a credit cap (PHASE_19 P19-16); the
  // prospect tool never does. Same status as the jobs route.
  over_max_credits: 409,
};

/** An https product link, normalized, or null for an empty or other value. */
export function cleanProductUrl(raw: string | undefined): string | null | "invalid" {
  const value = raw?.trim() ?? "";
  if (value.length === 0) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "invalid";
  } catch {
    return "invalid";
  }
}

export async function createProspectPack(
  ctx: OperatorContext,
  input: CreateProspectInput,
  now: Date = new Date(),
): Promise<CreateProspectOutcome> {
  const label = cleanProspectLabel(input.store);
  if (!label) {
    return { ok: false, status: 400, error: "Type the store name, up to 80 characters.", reason: "invalid" };
  }
  const productUrl = cleanProductUrl(input.productUrl);
  if (productUrl === "invalid") {
    return { ok: false, status: 400, error: "The product link must be an https link.", reason: "invalid" };
  }
  if (!isWorkspaceSourceKey(ctx.workspace.id, input.upload.key)) {
    return { ok: false, status: 403, error: "That upload does not belong to this workspace.", reason: "foreign_key" };
  }
  const channels = specsForChannels(input.channels);
  if (channels.length === 0) {
    return { ok: false, status: 400, error: "Pick at least one channel.", reason: "invalid" };
  }
  const result = await ctx.services.createJob(ctx.workspace.id, {
    productId: "new",
    channels,
    mode: "listing",
    idempotencyKey: `prospect:${input.idempotencyKey}`,
    uploads: [input.upload],
    newProductTitle: input.title || label,
    ...(input.note ? { userDescription: input.note } : {}),
    origin: productUrl ? "import" : "upload",
  });
  if (result.outcome === "conflict") {
    return { ok: false, status: 409, error: "This form was already sent with other values. Reload and try again.", reason: "conflict" };
  }
  if (result.outcome === "rejected") {
    return { ok: false, status: REJECTED_STATUS[result.reason], error: result.message, reason: result.reason };
  }
  const jobId = result.job.id;
  const claim = await insertProspectClaim(ctx.db, {
    jobId,
    staffWorkspaceId: ctx.workspace.id,
    label,
    productSourceUrl: productUrl,
    now,
  });
  if (claim.created) {
    await recordFunnelEvent(ctx.db, {
      workspaceId: ctx.workspace.id,
      name: "prospect_pack_made",
      props: { channels: channels.length, from: productUrl ? "import" : "upload" },
    });
  }
  const rows = await listProspects(ctx.db, ctx.workspace.id, now);
  return { ok: true, created: claim.created, prospect: rows.find((row) => row.id === claim.id) ?? null, jobId };
}

/**
 * Publishes each finished prospect pack that has no share page yet: the
 * whole pack, link only (never in the gallery, so never indexed) and with
 * the measured checks on (founder decision 9). A page the operator took
 * down by hand stays down. Returns the slugs it published.
 */
export async function publishReadyProspects(
  ctx: Pick<OperatorContext, "workspace">,
  shares: Pick<ShareStore, "publish">,
  rows: readonly ProspectRow[],
): Promise<string[]> {
  if (!canPublishShares(ctx.workspace.role)) {
    return [];
  }
  const published: string[] = [];
  for (const row of rows) {
    if (row.jobStatus !== "done" || row.shareSlug !== null || row.takenDownAt || row.claimedAt) {
      continue;
    }
    try {
      const result = await shares.publish({ id: ctx.workspace.id, role: ctx.workspace.role }, row.jobId, {
        kind: "pack",
        gallery: false,
        proof: true,
      });
      if (result.ok && result.status.slug) {
        published.push(result.status.slug);
      }
    } catch (err) {
      console.error("[prospects] could not publish a prospect pack", err instanceof Error ? err.message : err);
    }
  }
  return published;
}

/** The operator's prospects, publishing any that just finished first. */
export async function prospectsWithPublishing(
  ctx: OperatorContext,
  shares: Pick<ShareStore, "publish">,
  now: Date = new Date(),
): Promise<ProspectRow[]> {
  const rows = await listProspects(ctx.db, ctx.workspace.id, now);
  const published = await publishReadyProspects(ctx, shares, rows);
  return published.length > 0 ? listProspects(ctx.db, ctx.workspace.id, now) : rows;
}

export type ClaimLinkOutcome =
  | { ok: true; link: string; expiresAt: string; kit: OutreachKit }
  | { ok: false; status: number; error: string; reason: string };

/**
 * A fresh claim link for one finished, published prospect pack, with its
 * outreach kit. origin is the site's public origin.
 */
export async function makeClaimLink(
  ctx: OperatorContext,
  shares: Pick<ShareStore, "publish">,
  input: { claimId: string; origin: string; get: KitDeps["get"]; now?: Date },
): Promise<ClaimLinkOutcome> {
  const now = input.now ?? new Date();
  const rows = await prospectsWithPublishing(ctx, shares, now);
  const row = rows.find((candidate) => candidate.id === input.claimId);
  if (!row) {
    return { ok: false, status: 404, error: "Not found.", reason: "not_found" };
  }
  if (row.jobStatus !== "done" || !row.shareSlug || !row.sharePublished) {
    return { ok: false, status: 409, error: "The pack is not ready to send yet.", reason: "not_ready" };
  }
  const issued = await issueClaimLink(ctx.db, { claimId: row.id, staffWorkspaceId: ctx.workspace.id, now });
  if (!issued.ok) {
    return {
      ok: false,
      status: issued.reason === "not_found" ? 404 : 409,
      error: issued.reason === "claimed" ? "This pack was already claimed." : "This pack was taken down.",
      reason: issued.reason,
    };
  }
  const kit = await buildOutreachKit({ db: ctx.db, get: input.get }, { claimId: row.id, staffWorkspaceId: ctx.workspace.id });
  if (!kit) {
    return { ok: false, status: 404, error: "Not found.", reason: "not_found" };
  }
  const base = input.origin.replace(/\/+$/, "");
  const link = `${base}/s/${row.shareSlug}?claim=${issued.token}`;
  return { ok: true, link, expiresAt: issued.expiresAt.toISOString(), kit };
}

export type ClaimKitOutcome =
  | { ok: true; link: string | null; expiresAt: string | null; kit: OutreachKit }
  | { ok: false; status: number; error: string; reason: string };

/**
 * The outreach kit of one finished, published prospect pack again, with
 * its live claim link when the server can rebuild it (currentClaimLink),
 * and never a new token: the link the prospect already has keeps working
 * for the claim and the takedown. Reads only.
 */
export async function claimKit(
  ctx: OperatorContext,
  input: { claimId: string; origin: string; get: KitDeps["get"]; now?: Date },
): Promise<ClaimKitOutcome> {
  const now = input.now ?? new Date();
  const rows = await listProspects(ctx.db, ctx.workspace.id, now);
  const row = rows.find((candidate) => candidate.id === input.claimId);
  if (!row) {
    return { ok: false, status: 404, error: "Not found.", reason: "not_found" };
  }
  if (row.jobStatus !== "done" || !row.shareSlug || !row.sharePublished) {
    return { ok: false, status: 409, error: "The pack is not ready to send yet.", reason: "not_ready" };
  }
  const kit = await buildOutreachKit({ db: ctx.db, get: input.get }, { claimId: row.id, staffWorkspaceId: ctx.workspace.id });
  if (!kit) {
    return { ok: false, status: 404, error: "Not found.", reason: "not_found" };
  }
  const current = await currentClaimLink(ctx.db, { claimId: row.id, staffWorkspaceId: ctx.workspace.id, now });
  const base = input.origin.replace(/\/+$/, "");
  return {
    ok: true,
    link: current ? `${base}/s/${row.shareSlug}?claim=${current.token}` : null,
    expiresAt: current ? current.expiresAt.toISOString() : null,
    kit,
  };
}
