/**
 * What the public API v1 and the hosted MCP server do, transport neutral
 * (PHASE_16 workstream 5). The /api/v1 routes turn each ApiResult into a
 * JSON response and the /api/mcp tools into a tool result, so both surfaces
 * hold credits, rate limit and refuse exactly alike, and exactly as the web
 * form does:
 *
 * - Starting a pack goes through Services.createJob with an Idempotency-Key,
 *   so the credit hold, the plan entitlements, the role check (a key acts as
 *   the member who made it) and the replay rules are the form's own.
 * - Rate limits are the form's Upstash policies (jobs.create, imports.photo,
 *   uploads.preflight), counted per client IP and per member, so a key and
 *   its maker's browser share one allowance (founder decision 5).
 * - File links are signed and short lived (DOWNLOAD_URL_TTL_SECONDS).
 */

import { z } from "zod";
import { BUNDLE_KEYS, DEFAULT_BUNDLE, LOOK_KEYS, lookPresetFor, type BundleKey, type LookKey } from "@curvi/pipeline/output-options";
import { packBundles } from "@curvi/pipeline/seed";
import { flatPixelsOnWhite } from "@curvi/pipeline/pixels";
import { getSpec, hasSpec } from "@curvi/specs";
import type { ApiCaller } from "@/lib/api-keys/auth";
import { channelAvailability, tierKeyOf } from "@/lib/entitlements";
import { isR2Configured } from "@/lib/env";
import { InlineRunnerClosedError } from "@/lib/jobs/inline-runner";
import { CHANNEL_SPECS, amazonMainRules, channelName } from "@/lib/marketing-facts";
import { DOWNLOAD_URL_TTL_SECONDS } from "@/lib/r2";
import {
  checkRateLimit,
  clientIp,
  rateLimitMessage,
  type RateLimitDecision,
  type RateLimitPolicyName,
} from "@/lib/rate-limit";
import { RESTARTING_MESSAGE } from "@/lib/services/errors";
import type { CreateJobInput, CreateJobResult, JobView } from "@/lib/services/types";
import { RETRY_AFTER_SECONDS } from "@/lib/services/workspace-response";
import { checkRows, flattenOnWhite, measurePixels, summaryLine } from "@/lib/tools/main-image-analysis";
import { isUuid } from "@/lib/validation/ids";
import { discardStoredPhotos, readPhoto, storePackPhotos, type PhotoDeps } from "./photos";
import {
  CreatePackRequest,
  MainImageCheckRequest,
  type ErrorBody,
  type Pack,
} from "./schemas";

export interface ApiResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface ApiContext {
  caller: ApiCaller;
  /** The request headers, for the client IP. */
  headers: Headers;
  now?: Date;
  photos?: PhotoDeps;
}

export const IDEMPOTENCY_KEY_MAX = 200;

export const API_COPY = {
  idempotencyMissing: "Send an Idempotency-Key header with a fresh value for each new pack, and the same value when you retry.",
  idempotencyTooLong: `The Idempotency-Key must be ${IDEMPOTENCY_KEY_MAX} characters or fewer.`,
  idempotencyConflict: "This Idempotency-Key was already used with a different request.",
  packNotFound: "This pack does not exist in your workspace.",
  uploadsOff:
    "This server has no file storage, so it cannot take photos. Start the pack for a product that already has photos.",
  checkUnreadable: "We could not read that image. Send a JPEG, PNG or WEBP.",
  invalid: "Invalid request.",
} as const;

export function errorResult(status: number, reason: string, error: string, extra: Partial<ErrorBody> = {}): ApiResult {
  const body: ErrorBody = { error, reason, ...extra };
  return status === 503
    ? { status, body, headers: { "Retry-After": RETRY_AFTER_SECONDS } }
    : { status, body };
}

function rateLimited(decision: RateLimitDecision): ApiResult {
  return {
    status: 429,
    body: {
      error: rateLimitMessage(decision.retryAfterSeconds),
      reason: "rate_limited",
      retryAfterSeconds: decision.retryAfterSeconds,
    } satisfies ErrorBody,
    headers: {
      "Retry-After": String(decision.retryAfterSeconds),
      "X-RateLimit-Limit": String(decision.limit),
      "X-RateLimit-Remaining": "0",
    },
  };
}

/** The form's policy, by client IP and then by subject. */
export async function overLimit(
  policy: RateLimitPolicyName,
  headers: Headers,
  subject: string,
): Promise<ApiResult | null> {
  const ip = clientIp(headers);
  if (ip !== "unknown") {
    const byIp = await checkRateLimit(policy, "ip", `ip:${ip}`);
    if (!byIp.allowed) {
      return rateLimited(byIp);
    }
  }
  const bySubject = await checkRateLimit(policy, "user", subject);
  return bySubject.allowed ? null : rateLimited(bySubject);
}

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message));
}

/** Live spec ids per channel name, for "amazon" style channel entries. */
function liveSpecsOf(family: string): string[] {
  return CHANNEL_SPECS.filter((spec) => spec.status === "live" && spec.specId.split(".")[0] === family).map(
    (spec) => spec.specId,
  );
}

/** Spec ids for the requested channels: a spec id stays as sent, a channel
 * name becomes every live spec of it. Unknown entries are returned apart. */
export function expandChannels(requested: readonly string[]): { channels: string[]; unknown: string[] } {
  const channels: string[] = [];
  const unknown: string[] = [];
  for (const entry of requested) {
    const specs = hasSpec(entry) ? [entry] : liveSpecsOf(entry);
    if (specs.length === 0) {
      unknown.push(entry);
    }
    for (const spec of specs) {
      if (!channels.includes(spec)) {
        channels.push(spec);
      }
    }
  }
  return { channels, unknown };
}

const FINISHED = new Set(["done", "failed", "canceled"]);

export function packPath(id: string): string {
  return `/api/v1/packs/${id}`;
}

/** The public view of a pack: no session links, no internal ids beyond the
 * pack's and the product's. */
export function packOf(job: JobView): Pack {
  return {
    id: job.id,
    status: job.status,
    finished: FINISHED.has(job.status),
    productId: job.productId,
    productTitle: job.productTitle,
    channels: [...job.channels],
    creditsReserved: job.creditsReserved,
    creditsCharged: job.creditsCharged,
    createdAt: job.createdAt,
    error: job.error ?? null,
    shots: job.shots.map((shot) => ({
      id: shot.shotId,
      type: shot.shotType,
      status: shot.status,
      channels: [...shot.channels],
      credits: shot.credits,
      note: shot.note ?? null,
      compliance: shot.compliance
        ? {
            pass: shot.compliance.pass,
            fillPct: shot.compliance.fillPct,
            background: shot.compliance.background ? [...shot.compliance.background] : null,
          }
        : null,
    })),
    links: { self: packPath(job.id), files: `${packPath(job.id)}/files` },
  };
}

/** The same statuses POST /api/jobs answers each refusal with. */
const REJECTED_STATUS: Record<Extract<CreateJobResult, { outcome: "rejected" }>["reason"], number> = {
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
};

/** The request body with the bundle shortcut folded into the options, or
 * null when bundle and outputOptions.bundle name different bundles. */
export function withBundle(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const body = raw as Record<string, unknown>;
  const options = body.outputOptions;
  if (body.bundle === undefined || (options !== undefined && (typeof options !== "object" || options === null || Array.isArray(options)))) {
    // Nothing to fold, or options the schema refuses anyway.
    return raw;
  }
  const current = (options as Record<string, unknown> | undefined)?.bundle;
  if (current !== undefined && current !== body.bundle) {
    return null;
  }
  return { ...body, outputOptions: { ...(options as Record<string, unknown> | undefined), bundle: body.bundle } };
}

/** The request body with the look shortcut expanded into output options:
 * the look's seeded preset for the pack's bundle, with lookBase set, under
 * any outputOptions fields sent alongside it (the web form's look cards
 * work the same way). Runs after withBundle, before the schema parse, so
 * the options' defaults never override the preset. */
export function withLook(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const body = raw as Record<string, unknown>;
  const look = body.look;
  const options = body.outputOptions;
  if (
    typeof look !== "string" ||
    !(LOOK_KEYS as readonly string[]).includes(look) ||
    (options !== undefined && (typeof options !== "object" || options === null || Array.isArray(options)))
  ) {
    // Nothing to expand, or a value the schema refuses anyway.
    return raw;
  }
  const sent = (options as Record<string, unknown> | undefined) ?? {};
  const bundle =
    typeof sent.bundle === "string" && (BUNDLE_KEYS as readonly string[]).includes(sent.bundle)
      ? (sent.bundle as BundleKey)
      : DEFAULT_BUNDLE;
  return { ...body, outputOptions: { ...lookPresetFor(look as LookKey, bundle), lookBase: look, ...sent } };
}

/** POST /api/v1/packs and the create_pack tool. */
export async function createPack(ctx: ApiContext, rawBody: unknown, idempotencyKey: string | null): Promise<ApiResult> {
  const { caller } = ctx;
  const limited = await overLimit("jobs.create", ctx.headers, caller.rateSubject);
  if (limited) {
    return limited;
  }
  if (!idempotencyKey) {
    return errorResult(400, "idempotency_key_required", API_COPY.idempotencyMissing);
  }
  if (idempotencyKey.length > IDEMPOTENCY_KEY_MAX) {
    return errorResult(400, "idempotency_key_too_long", API_COPY.idempotencyTooLong);
  }

  const bundled = withBundle(rawBody);
  if (bundled === null) {
    return errorResult(400, "invalid_request", API_COPY.invalid, {
      issues: ["bundle: It must match outputOptions.bundle when both are sent."],
    });
  }
  const parsed = CreatePackRequest.safeParse(withLook(bundled));
  if (!parsed.success) {
    return errorResult(400, "invalid_request", API_COPY.invalid, { issues: issuesOf(parsed.error) });
  }
  const request = parsed.data;

  const { channels, unknown } = expandChannels(request.channels);
  if (unknown.length > 0) {
    return errorResult(400, "unknown_channels", `Unknown channels: ${unknown.join(", ")}. List them with GET /api/v1/channels.`);
  }

  const workspaceId = caller.principal.workspaceId;
  if (caller.principal.role === "client") {
    // Refused before any photo is fetched or stored, as the photo import
    // route does; createJob would refuse the seat anyway.
    return errorResult(403, "role_forbidden", "Client seats can review assets but cannot start packs or spend credits.");
  }
  let uploads: CreateJobInput["uploads"];
  let created: string[] = [];
  const photos = request.photos ?? [];
  if (photos.length > 0) {
    const store = caller.services.mode === "db";
    if (store && !isR2Configured()) {
      return errorResult(503, "uploads_not_configured", API_COPY.uploadsOff);
    }
    if (photos.some((photo) => photo.url !== undefined)) {
      const importLimited = await overLimit("imports.photo", ctx.headers, `ws:${workspaceId}`);
      if (importLimited) {
        return importLimited;
      }
    }
    const stored = await storePackPhotos(workspaceId, photos, { store, ...ctx.photos });
    if (!stored.ok) {
      return errorResult(stored.status, stored.reason, stored.message);
    }
    uploads = stored.uploads;
    created = stored.created;
  }

  let result: CreateJobResult;
  try {
    result = await caller.services.createJob(workspaceId, {
      productId: request.productId ?? "new",
      channels,
      mode: "listing",
      idempotencyKey,
      ...(uploads ? { uploads } : {}),
      ...(request.title !== undefined ? { newProductTitle: request.title } : {}),
      ...(request.note ? { userDescription: request.note } : {}),
      ...(request.sku !== undefined ? { sku: request.sku } : {}),
      ...(request.boxContents !== undefined ? { boxContents: request.boxContents } : {}),
      ...(request.comparisonFacts !== undefined ? { comparisonFacts: request.comparisonFacts } : {}),
      ...(request.endorsements !== undefined ? { endorsements: request.endorsements } : {}),
      ...(request.outputOptions !== undefined ? { outputOptions: request.outputOptions } : {}),
    });
  } catch (err) {
    await discardStoredPhotos(created, ctx.photos);
    if (err instanceof InlineRunnerClosedError) {
      return errorResult(503, "unavailable", RESTARTING_MESSAGE);
    }
    throw err;
  }
  if (result.outcome !== "created") {
    // Only a new pack uses the photos this request wrote: a replay or a
    // conflict answers with the pack the key already made, and a refusal
    // makes none. Photos that were already stored are never in `created`.
    await discardStoredPhotos(created, ctx.photos);
  }

  switch (result.outcome) {
    case "created":
      return { status: 201, body: { pack: packOf(result.job) }, headers: { Location: packPath(result.job.id) } };
    case "replayed":
      return { status: 200, body: { pack: packOf(result.job), replayed: true } };
    case "conflict":
      return errorResult(409, "idempotency_conflict", API_COPY.idempotencyConflict, {
        ...(result.existingJobId ? { existingPackId: result.existingJobId } : {}),
      });
    case "rejected":
      return errorResult(REJECTED_STATUS[result.reason], result.reason, result.message);
  }
}

/** GET /api/v1/packs/{id} and the get_pack tool. */
export async function getPack(ctx: ApiContext, id: string): Promise<ApiResult> {
  if (!isUuid(id)) {
    return errorResult(404, "not_found", API_COPY.packNotFound);
  }
  const job = await ctx.caller.services.getJob(ctx.caller.principal.workspaceId, id);
  if (!job) {
    return errorResult(404, "not_found", API_COPY.packNotFound);
  }
  return { status: 200, body: { pack: packOf(job) }, headers: { "Cache-Control": "no-store" } };
}

/** GET /api/v1/packs/{id}/files: every delivered file with a freshly
 * signed download link that expires in DOWNLOAD_URL_TTL_SECONDS. */
export async function listPackFiles(ctx: ApiContext, id: string): Promise<ApiResult> {
  if (!isUuid(id)) {
    return errorResult(404, "not_found", API_COPY.packNotFound);
  }
  const workspaceId = ctx.caller.principal.workspaceId;
  const view = await ctx.caller.services.listJobFiles(workspaceId, id);
  if (!view) {
    return errorResult(404, "not_found", API_COPY.packNotFound);
  }
  const now = ctx.now ?? new Date();
  const expiresAt = new Date(now.getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString();
  const files = await Promise.all(
    view.files.map(async (file) => {
      const download = file.downloadUrl ? await ctx.caller.services.getJobFileDownload(workspaceId, id, file.id) : null;
      return {
        id: file.id,
        name: download?.filename ?? file.name,
        channel: file.channel,
        specId: file.specId,
        kind: file.kind,
        bytes: file.bytes,
        url: download?.url ?? null,
        expiresAt: download ? expiresAt : null,
      };
    }),
  );
  return {
    status: 200,
    body: {
      packId: view.jobId,
      status: view.status,
      files,
      ...(view.notice ? { notice: view.notice } : {}),
    },
    headers: { "Cache-Control": "no-store" },
  };
}

/** POST /api/v1/checks/main-image and the check_main_image tool: the free
 * Amazon main image checker, run on the server with the registry's rules.
 * Reads pixels only; nothing is stored and no credit is used. */
export async function checkMainImage(ctx: ApiContext, rawBody: unknown): Promise<ApiResult> {
  const limited = await overLimit("uploads.preflight", ctx.headers, ctx.caller.rateSubject);
  if (limited) {
    return limited;
  }
  const parsed = MainImageCheckRequest.safeParse(rawBody);
  if (!parsed.success) {
    return errorResult(400, "invalid_request", API_COPY.invalid, { issues: issuesOf(parsed.error) });
  }
  const read = await readPhoto(parsed.data, ctx.photos);
  if (!read.ok) {
    const status = { invalid_url: 400, blocked_host: 400, not_image: 422, too_large: 422, timeout: 504, unreachable: 502 }[
      read.reason
    ];
    return errorResult(status, read.reason, read.message);
  }
  let pixels;
  try {
    pixels = await flatPixelsOnWhite(read.photo.body);
  } catch {
    return errorResult(422, "not_image", API_COPY.checkUnreadable);
  }
  const rules = amazonMainRules();
  const checkerRules = {
    minLongSide: rules.minLongSide,
    fillMinPercent: rules.fillMinPercent,
    fillMaxPercent: rules.fillMaxPercent,
  };
  flattenOnWhite(pixels.data);
  const rows = checkRows(
    { width: pixels.naturalWidth, height: pixels.naturalHeight },
    measurePixels(pixels.data, pixels.width, pixels.height),
    checkerRules,
  );
  return {
    status: 200,
    body: {
      pass: rows.every((row) => row.pass),
      summary: summaryLine(rows),
      width: pixels.naturalWidth,
      height: pixels.naturalHeight,
      checks: rows,
      rules: checkerRules,
    },
  };
}

/** GET /api/v1/channels and the list_channels tool: every channel spec a
 * pack can name, with whether this workspace's plan can use it today. */
export function listChannels(ctx: Pick<ApiContext, "caller">): ApiResult {
  const tier = tierKeyOf(ctx.caller.principal.plan);
  const channels = CHANNEL_SPECS.filter((entry) => hasSpec(entry.specId)).map((entry) => {
    const spec = getSpec(entry.specId);
    const availability = channelAvailability(entry.specId, tier);
    const family = entry.specId.split(".")[0] ?? entry.specId;
    return {
      id: entry.specId,
      channel: family,
      name: `${channelName(family)} ${entry.files}`,
      width: spec.width ?? null,
      height: spec.height ?? null,
      availability: availability.status,
      upgradeTo: availability.status === "upgrade_required" ? (availability.upgradeTo ?? null) : null,
    };
  });
  const bundles = Object.values(packBundles).map((bundle) => ({ key: bundle.key, label: bundle.label }));
  return { status: 200, body: { channels, bundles } };
}
