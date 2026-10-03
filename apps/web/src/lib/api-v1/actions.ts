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
 *
 * PHASE_19 adds what ChatGPT and other assistants need on top (P19-14,
 * P19-16): estimate_pack, the signed quote and max_credits create_pack
 * checks before anything is held, a server derived replay key, and, on
 * every refusal an assistant can meet, the neutral line it reads instead of
 * the REST text (ApiResult.assistantMessage, from MCP_COPY). The REST bodies
 * are unchanged.
 */

import { z } from "zod";
import { BUNDLE_KEYS, DEFAULT_BUNDLE, LOOK_KEYS, lookPresetFor, type BundleKey, type LookKey } from "@curvi/pipeline/output-options";
import { uprightSize } from "@curvi/pipeline/ingest";
import { packBundles } from "@curvi/pipeline/seed";
import { flatPixelsOnWhite } from "@curvi/pipeline/pixels";
import { getSpec, hasSpec } from "@curvi/specs";
import type { ApiCaller } from "@/lib/api-keys/auth";
import { channelAvailability, checkChannelEntitlements, tierKeyOf } from "@/lib/entitlements";
import { isR2Configured } from "@/lib/env";
import { InlineRunnerClosedError } from "@/lib/jobs/inline-runner";
import { CHANNEL_SPECS, channelFamilyOf, channelName } from "@/lib/marketing-facts";
import type { SigningKey } from "@/lib/mcp-signing";
import { DOWNLOAD_URL_TTL_SECONDS, apiSourceKey } from "@/lib/r2";
import {
  MCP_TOOL_RATE_POLICIES,
  checkRateLimit,
  clientIp,
  rateLimitMessage,
  type RateLimitDecision,
  type RateLimitPolicyName,
} from "@/lib/rate-limit";
import { RESTARTING_MESSAGE } from "@/lib/services/errors";
import { OPTIONS_UNAVAILABLE_MESSAGE } from "@/lib/services/output-options";
import type {
  CreateJobInput,
  CreateJobLifecycle,
  CreateJobRejection,
  CreateJobResult,
  EstimateJobInput,
  JobView,
  ServiceReadOptions,
} from "@/lib/services/types";
import { RETRY_AFTER_SECONDS } from "@/lib/services/workspace-response";
import { checkRows, flattenOnWhite, measurePixels, summaryLine } from "@/lib/tools/main-image-analysis";
import { checkerChannels, defaultCheckerChannel } from "@/lib/tools/checker-rules";
import { isUuid } from "@/lib/validation/ids";
import { estimateChatOf } from "./chat-views";
import { MCP_COPY } from "./mcp-copy";
import {
  QUOTE_TTL_MINUTES,
  canonicalPack,
  checkQuote,
  derivedIdempotencyKeys,
  quoteSigningKeys,
  signQuote,
  type ParsedPackRequest,
} from "./pack-quote";
import {
  NO_ATTACHMENT,
  PHOTO_FAILURE_STATUS,
  assistantPhotoMessage,
  discardStoredPhotos,
  missingAttachmentIn,
  readPhoto,
  storePackPhotos,
  type PackPhotoSource,
  type PhotoDeps,
} from "./photos";
import {
  CHAT_FILE_FIELDS,
  CreatePackRequest,
  MainImageCheckRequest,
  type ErrorBody,
  type Pack,
} from "./schemas";

export interface ApiResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** The line an assistant reads instead of body.error, from MCP_COPY, where
   * the REST text would name a plan, a top up, a REST detail or a web form
   * step (PHASE_19 "Neutral messages"). The REST routes never send it. */
  assistantMessage?: string;
  /** One plain sentence an MCP tool sends after its JSON, for the model to
   * relay (PHASE_19 P19-13). The REST routes never send it. */
  summary?: string;
}

/** The result with the line an assistant reads in place of its REST text. */
export function forAssistant(result: ApiResult, line: string | undefined): ApiResult {
  return line === undefined ? result : { ...result, assistantMessage: line };
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

/**
 * The form's policy for a caller (PHASE_19 P19-21). An API key caller is
 * counted by client IP and then by subject (the caller's own rate subject
 * unless another is named), exactly as before. An ipExempt caller (OAuth,
 * whose calls all arrive from OpenAI's shared egress addresses) skips the
 * IP rule and is counted by subject and by workspace instead, so callers
 * from one assistant never share a bucket.
 */
export async function overLimit(
  policy: RateLimitPolicyName,
  headers: Headers,
  caller: ApiCaller,
  subject: string = caller.rateSubject,
): Promise<ApiResult | null> {
  const ip = caller.ipExempt ? "unknown" : clientIp(headers);
  if (ip !== "unknown") {
    const byIp = await checkRateLimit(policy, "ip", `ip:${ip}`);
    if (!byIp.allowed) {
      return rateLimited(byIp);
    }
  }
  const bySubject = await checkRateLimit(policy, "user", subject);
  if (!bySubject.allowed) {
    return rateLimited(bySubject);
  }
  const workspace = `ws:${caller.principal.workspaceId}`;
  if (caller.ipExempt && workspace !== subject) {
    const byWorkspace = await checkRateLimit(policy, "workspace", workspace);
    if (!byWorkspace.allowed) {
      return rateLimited(byWorkspace);
    }
  }
  return null;
}

/** The limit an MCP tool call meets before it runs (MCP_TOOL_RATE_POLICIES:
 * the reads and estimate_pack's photo reads), or null for a tool whose
 * action counts its own policy or one under no limit. */
export async function toolOverLimit(tool: string, ctx: Pick<ApiContext, "caller" | "headers">): Promise<ApiResult | null> {
  const policy = Object.hasOwn(MCP_TOOL_RATE_POLICIES, tool) ? MCP_TOOL_RATE_POLICIES[tool] : undefined;
  return policy ? overLimit(policy, ctx.headers, ctx.caller) : null;
}

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message));
}

/** A chat attachment field (CHAT_FILE_FIELDS) sent to the public REST API,
 * refused as the strict schema refused it before the field existed: the
 * REST contract is unchanged by PHASE_19, and only the MCP tools take
 * attachments (P19-15). Null when the body does not carry the field. */
export function chatFileRefused(body: unknown, field: (typeof CHAT_FILE_FIELDS)[number]): ApiResult | null {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(body, field)) {
    return null;
  }
  return errorResult(400, "invalid_request", API_COPY.invalid, { issues: [`Unrecognized key: "${field}"`] });
}

/** Live spec ids per channel name, for "amazon" style channel entries. */
function liveSpecsOf(family: string): string[] {
  return CHANNEL_SPECS.filter((spec) => spec.status === "live" && spec.specId.split(".")[0] === family).map(
    (spec) => spec.specId,
  );
}

/** Spec ids for the requested channels: a spec id stays as sent, a channel
 * name or alias (instagram for meta, PHASE_19 P19-18) becomes every live
 * spec of it. Unknown entries are returned apart. */
export function expandChannels(requested: readonly string[]): { channels: string[]; unknown: string[] } {
  const channels: string[] = [];
  const unknown: string[] = [];
  for (const entry of requested) {
    const specs = hasSpec(entry) ? [entry] : liveSpecsOf(channelFamilyOf(entry) ?? entry);
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
            fidelity: shot.compliance.fidelity ? { ...shot.compliance.fidelity } : null,
          }
        : null,
    })),
    links: { self: packPath(job.id), files: `${packPath(job.id)}/files` },
  };
}

/** The same statuses POST /api/jobs answers each refusal with. */
const REJECTED_STATUS: Record<CreateJobRejection["reason"], number> = {
  maintenance: 503,
  workspace_day_cap: 429,
  empty_plan: 422,
  unknown_product: 404,
  role_forbidden: 403,
  needs_photo: 400,
  no_media: 400,
  insufficient_credits: 402,
  credit_budget_exceeded: 409,
  upgrade_required: 402,
  feature_unavailable: 422,
  unavailable: 503,
  mode_unavailable: 400,
  invalid_upload: 422,
  invalid_options: 400,
  over_max_credits: 409,
};

/**
 * The neutral line an assistant reads for a createJob or estimateJob
 * refusal (PHASE_19 "Neutral messages"), or undefined when the service's own
 * line already fits. The plan names the feature at fault, never a plan to
 * buy: an upgrade_required with every channel entitled is the brand color
 * a plan without a brand kit cannot use.
 */
export function assistantRejectionLine(
  rejection: CreateJobRejection,
  channels: readonly string[],
  plan: string,
): string | undefined {
  switch (rejection.reason) {
    case "maintenance":
      return MCP_COPY.packsPaused;
    case "workspace_day_cap":
      return MCP_COPY.workspaceDayCap;
    case "empty_plan":
      return MCP_COPY.noImagesPlanned;
    case "insufficient_credits":
      return rejection.creditsNeeded !== undefined && rejection.creditsAvailable !== undefined
        ? MCP_COPY.insufficientCredits(rejection.creditsNeeded, rejection.creditsAvailable)
        : undefined;
    case "over_max_credits":
      return rejection.creditsNeeded !== undefined && rejection.maxCredits !== undefined
        ? MCP_COPY.overMaxCredits(rejection.creditsNeeded, rejection.maxCredits)
        : MCP_COPY.quoteNeeded;
    case "upgrade_required": {
      const check = checkChannelEntitlements([...channels], tierKeyOf(plan));
      return !check.ok && check.reason === "upgrade_required"
        ? MCP_COPY.featureNotInPlan(check.featureName ?? "This feature")
        : MCP_COPY.brandColorsNotInPlan;
    }
    case "role_forbidden":
      return MCP_COPY.clientSeat;
    case "needs_photo":
      return MCP_COPY.noAttachment;
    case "feature_unavailable":
      // The web line names the form's "Marketplace ready" choice, which an
      // assistant cannot map to an argument.
      return rejection.message === OPTIONS_UNAVAILABLE_MESSAGE ? MCP_COPY.optionsPaused : undefined;
    default:
      return undefined;
  }
}

function rejectedResult(rejection: CreateJobRejection, channels: readonly string[], caller: ApiCaller): ApiResult {
  return forAssistant(
    errorResult(REJECTED_STATUS[rejection.reason], rejection.reason, rejection.message),
    assistantRejectionLine(rejection, channels, caller.principal.plan),
  );
}

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

/** A pack request parsed as create_pack and estimate_pack both read it: the
 * bundle and look shortcuts folded in, the channels expanded to specs. */
type PackRequestRead = { ok: true; request: ParsedPackRequest; channels: string[] } | { ok: false; result: ApiResult };

function readPackRequest(rawBody: unknown, caller: ApiCaller): PackRequestRead {
  const bundled = withBundle(rawBody);
  if (bundled === null) {
    return {
      ok: false,
      result: errorResult(400, "invalid_request", API_COPY.invalid, {
        issues: ["bundle: It must match outputOptions.bundle when both are sent."],
      }),
    };
  }
  // A file argument with nothing usable in it (absent, or a placeholder a
  // model wrote in place of the file) gets the attach line, not a schema
  // error (P19-15). The REST routes refuse the field before this runs.
  if (missingAttachmentIn(bundled, "images")) {
    return { ok: false, result: errorResult(NO_ATTACHMENT.status, NO_ATTACHMENT.reason, NO_ATTACHMENT.message) };
  }
  const parsed = CreatePackRequest.safeParse(withLook(bundled));
  if (!parsed.success) {
    return { ok: false, result: errorResult(400, "invalid_request", API_COPY.invalid, { issues: issuesOf(parsed.error) }) };
  }
  const request = parsed.data;
  if (request.images !== undefined && request.photos !== undefined) {
    return {
      ok: false,
      result: forAssistant(
        errorResult(400, "invalid_request", API_COPY.invalid, { issues: [NO_ATTACHMENT.bothSources] }),
        NO_ATTACHMENT.bothSources,
      ),
    };
  }

  const { channels, unknown } = expandChannels(request.channels);
  if (unknown.length > 0) {
    return {
      ok: false,
      result: forAssistant(
        errorResult(400, "unknown_channels", `Unknown channels: ${unknown.join(", ")}. List them with GET /api/v1/channels.`),
        MCP_COPY.unknownChannels(unknown),
      ),
    };
  }
  if (caller.principal.role === "client") {
    // Refused before any photo is fetched or stored, as the photo import
    // route does; createJob would refuse the seat anyway.
    return { ok: false, result: errorResult(403, "role_forbidden", MCP_COPY.clientSeat) };
  }
  return { ok: true, request, channels };
}

/** createJob's fields from a parsed pack request, other than the photos. */
function jobFieldsOf(
  request: ParsedPackRequest,
): Omit<EstimateJobInput, "productId" | "channels" | "mode" | "uploads"> {
  return {
    ...(request.title !== undefined ? { newProductTitle: request.title } : {}),
    ...(request.note ? { userDescription: request.note } : {}),
    ...(request.sku !== undefined ? { sku: request.sku } : {}),
    ...(request.boxContents !== undefined ? { boxContents: request.boxContents } : {}),
    ...(request.comparisonFacts !== undefined ? { comparisonFacts: request.comparisonFacts } : {}),
    ...(request.endorsements !== undefined ? { endorsements: request.endorsements } : {}),
    ...(request.outputOptions !== undefined ? { outputOptions: request.outputOptions } : {}),
    ...(request.answers !== undefined ? { answers: request.answers } : {}),
  };
}

/** The quote signing ring, or null when none is set in production (or the
 * value is malformed, which is logged without the value). */
function quoteKeys(): SigningKey[] | null {
  try {
    return quoteSigningKeys();
  } catch (err) {
    console.error("[mcp] MCP_LINK_KEYS could not be read", err instanceof Error ? err.message : err);
    return null;
  }
}

function quotesUnavailable(): ApiResult {
  return forAssistant(errorResult(503, "unavailable", MCP_COPY.estimateUnavailable), MCP_COPY.estimateUnavailable);
}

/**
 * What an assistant's create_pack adds to the REST request (PHASE_19 P19-16,
 * founder decision 5). With it, a missing Idempotency-Key is derived by the
 * server instead of refused.
 */
export interface AssistantPackGuard {
  /** The quote estimate_pack returned for the same photos and choices. */
  quote?: string;
  /** The most credits the pack may hold. */
  maxCredits?: number;
  /** OAuth callers must send both a quote and max_credits; API key callers
   * may send either. */
  quoteRequired: boolean;
}

/**
 * POST /api/v1/packs and the create_pack tool. The tool passes `assistant`:
 * then the quote is checked against this workspace, these choices and these
 * photos before anything is held, createJob refuses a hold above the quote
 * or max_credits, and with no Idempotency-Key (always, for an OAuth caller)
 * the key is derived from the connection, the member, the photos and the
 * choices per 10 minute window, the previous window's checked first.
 */
export async function createPack(
  ctx: ApiContext,
  rawBody: unknown,
  idempotencyKey: string | null,
  assistant?: AssistantPackGuard,
): Promise<ApiResult> {
  const { caller } = ctx;
  const limited = await overLimit("jobs.create", ctx.headers, caller);
  if (limited) {
    return limited;
  }
  if (!idempotencyKey && !assistant) {
    return errorResult(400, "idempotency_key_required", API_COPY.idempotencyMissing);
  }
  if (idempotencyKey && idempotencyKey.length > IDEMPOTENCY_KEY_MAX) {
    return errorResult(400, "idempotency_key_too_long", API_COPY.idempotencyTooLong);
  }

  const read = readPackRequest(rawBody, caller);
  if (!read.ok) {
    return read.result;
  }
  const { request, channels } = read;
  const workspaceId = caller.principal.workspaceId;

  // An assistant's quote is checked for presence and for keys before any
  // photo is fetched; its match to the photos is checked once they are read.
  let keys: SigningKey[] | null = null;
  if (assistant) {
    if (assistant.quoteRequired && assistant.quote === undefined) {
      return forAssistant(errorResult(400, "quote_required", MCP_COPY.quoteNeeded), MCP_COPY.quoteNeeded);
    }
    // Decision 5 asks for both. A quote without max_credits gets its own line
    // naming the field, since a new estimate would not fix it.
    if (assistant.quoteRequired && assistant.maxCredits === undefined) {
      return forAssistant(errorResult(400, "max_credits_required", MCP_COPY.maxCreditsNeeded), MCP_COPY.maxCreditsNeeded);
    }
    if (assistant.quote !== undefined) {
      keys = quoteKeys();
      if (!keys) {
        return quotesUnavailable();
      }
    }
  }

  let uploads: CreateJobInput["uploads"];
  let created: string[] = [];
  // Photo links or base64 (photos), or files attached in ChatGPT (images).
  const photos: readonly PackPhotoSource[] = request.photos ?? request.images ?? [];
  if (photos.length > 0) {
    const store = caller.services.mode === "db";
    if (store && !isR2Configured()) {
      return errorResult(503, "uploads_not_configured", API_COPY.uploadsOff);
    }
    if (photos.some((photo) => photo.url !== undefined || photo.download_url !== undefined)) {
      const importLimited = await overLimit("imports.photo", ctx.headers, caller, `ws:${workspaceId}`);
      if (importLimited) {
        return importLimited;
      }
    }
    // An assistant hears the neutral photo copy (an attachment always does).
    const stored = await storePackPhotos(workspaceId, photos, {
      store,
      ...ctx.photos,
      ...(assistant ? { audience: "assistant" as const } : {}),
    });
    if (!stored.ok) {
      return errorResult(stored.status, stored.reason, stored.message);
    }
    uploads = stored.uploads;
    created = stored.created;
  }

  let key = idempotencyKey;
  let maxCredits: number | undefined;
  let previousKeys: string[] | undefined;
  if (assistant) {
    const now = ctx.now ?? new Date();
    const pack = canonicalPack(
      request,
      channels,
      (uploads ?? []).map((upload) => ({ sha256: upload.sha256, ...(upload.angle ? { angle: upload.angle } : {}) })),
    );
    if (assistant.quote !== undefined && keys) {
      const quote = checkQuote(keys, assistant.quote, { workspaceId, pack, now });
      if (!quote.ok) {
        // Nothing is held for a quote that does not match: the photos this
        // request wrote are taken back.
        // An expired quote needs a new one, like a missing one; any other
        // failure is a quote for another workspace, other choices or other
        // photos.
        await discardStoredPhotos(created, ctx.photos);
        return forAssistant(
          quote.reason === "expired"
            ? errorResult(400, "quote_required", MCP_COPY.quoteNeeded)
            : errorResult(409, "quote_mismatch", MCP_COPY.quoteNeeded),
          MCP_COPY.quoteNeeded,
        );
      }
      maxCredits = Math.min(quote.credits, assistant.maxCredits ?? quote.credits);
    } else if (assistant.maxCredits !== undefined) {
      maxCredits = assistant.maxCredits;
    }
    if (!key) {
      const derived = derivedIdempotencyKeys({
        subject: caller.connectionId ?? caller.keyId ?? "none",
        userId: caller.principal.userId,
        pack,
        now,
      });
      key = derived.current;
      previousKeys = [derived.previous];
    }
  }
  if (!key) {
    // Unreachable: a REST call without a key was refused above.
    return errorResult(400, "idempotency_key_required", API_COPY.idempotencyMissing);
  }

  const lifecycle: CreateJobLifecycle = { retainUploads: false };
  let result: CreateJobResult;
  try {
    result = await caller.services.createJob(workspaceId, {
      productId: request.productId ?? "new",
      channels,
      mode: "listing",
      idempotencyKey: key,
      origin: "api",
      ...(uploads ? { uploads } : {}),
      ...jobFieldsOf(request),
      ...(maxCredits !== undefined ? { maxCredits } : {}),
      ...(previousKeys ? { previousIdempotencyKeys: previousKeys } : {}),
      // Every create_pack through /api/mcp: the worker screens it for
      // OpenAI's prohibited goods (PHASE_19 P19-29). The REST API does not.
      ...(assistant ? { audience: "assistant" as const } : {}),
    }, lifecycle);
  } catch (err) {
    if (!lifecycle.retainUploads) await discardStoredPhotos(created, ctx.photos);
    if (err instanceof InlineRunnerClosedError) {
      return errorResult(503, "unavailable", RESTARTING_MESSAGE);
    }
    throw err;
  }
  if (result.outcome !== "created" && !lifecycle.retainUploads) {
    // Cleanup owns only uploads that could not have been published. Once
    // persistence begins, even a refused or interrupted request may have
    // committed sources that another pack already uses.
    await discardStoredPhotos(created, ctx.photos);
  }

  switch (result.outcome) {
    case "created":
      return { status: 201, body: { pack: packOf(result.job) }, headers: { Location: packPath(result.job.id) } };
    case "replayed":
      return { status: 200, body: { pack: packOf(result.job), replayed: true } };
    case "conflict":
      return forAssistant(
        errorResult(409, "idempotency_conflict", API_COPY.idempotencyConflict, {
          ...(result.existingJobId ? { existingPackId: result.existingJobId } : {}),
        }),
        MCP_COPY.idempotencyConflict,
      );
    case "rejected":
      return rejectedResult(result, channels, caller);
  }
}

/** One photo of an estimate: createJob's key and hash for the same bytes,
 * and the upright size its ingest records. */
type MeasuredPhoto = NonNullable<EstimateJobInput["uploads"]>[number];

/**
 * Reads the request's photos the way create_pack would and measures them,
 * storing nothing (estimate_pack). Each keeps createJob's key and hash, and
 * the same photo twice is one photo, as storePackPhotos does.
 */
async function measurePackPhotos(
  workspaceId: string,
  photos: readonly PackPhotoSource[],
  deps: PhotoDeps | undefined,
): Promise<{ ok: true; uploads: MeasuredPhoto[] } | { ok: false; result: ApiResult }> {
  const uploads: MeasuredPhoto[] = [];
  for (const [index, source] of photos.entries()) {
    // A link, base64 bytes or a file attached in ChatGPT (P19-15).
    const read = await readPhoto(source, deps, { number: index + 1, audience: "assistant" });
    if (!read.ok) {
      return {
        ok: false,
        result: forAssistant(
          errorResult(PHOTO_FAILURE_STATUS[read.reason], read.reason, read.message),
          assistantPhotoMessage(read, index + 1),
        ),
      };
    }
    const size = await uprightSize(read.photo.body);
    if (!size) {
      return {
        ok: false,
        result: forAssistant(
          errorResult(422, "not_image", `Photo ${index + 1}: ${API_COPY.checkUnreadable}`),
          MCP_COPY.photoUnreadable(index + 1),
        ),
      };
    }
    const key = apiSourceKey(workspaceId, read.photo.sha256);
    if (uploads.some((upload) => upload.key === key)) {
      continue;
    }
    uploads.push({
      key,
      sha256: read.photo.sha256,
      kind: "image",
      ...(source.angle ? { angle: source.angle } : {}),
      width: size.width,
      height: size.height,
    });
  }
  return { ok: true, uploads };
}

/**
 * The estimate_pack tool (PHASE_19 P19-16): the credits create_pack would
 * hold for the same photos and choices, the workspace's balance, the
 * channels it would leave out, and a quote signed for this workspace, these
 * choices and these photos, valid QUOTE_TTL_MINUTES. Photo links are fetched
 * to read each photo's size and hash; nothing is stored and nothing is held.
 * Rate limited as a photo import once, before it runs, by toolOverLimit
 * (MCP_TOOL_RATE_POLICIES, P19-21), so the action does not count it again.
 */
export async function estimatePack(ctx: ApiContext, rawBody: unknown): Promise<ApiResult> {
  const { caller } = ctx;
  const read = readPackRequest(rawBody, caller);
  if (!read.ok) {
    return read.result;
  }
  const { request, channels } = read;
  const keys = quoteKeys();
  if (!keys) {
    return quotesUnavailable();
  }
  const workspaceId = caller.principal.workspaceId;
  const measured = await measurePackPhotos(workspaceId, request.photos ?? request.images ?? [], ctx.photos);
  if (!measured.ok) {
    return measured.result;
  }
  const estimate = await caller.services.estimateJob(
    workspaceId,
    {
      productId: request.productId ?? "new",
      channels,
      mode: "listing",
      ...(measured.uploads.length > 0 ? { uploads: measured.uploads } : {}),
      ...jobFieldsOf(request),
    },
    { reconcile: false },
  );
  if (estimate.outcome === "rejected") {
    return rejectedResult(estimate, channels, caller);
  }
  const quote = signQuote(keys, {
    workspaceId,
    pack: canonicalPack(request, channels, measured.uploads),
    credits: estimate.creditsNeeded,
    now: ctx.now ?? new Date(),
  });
  const body = estimateChatOf({
    creditsNeeded: estimate.creditsNeeded,
    creditsAvailable: estimate.creditsAvailable,
    creditBudget: estimate.creditBudget,
    channels: estimate.channels,
    leftOut: estimate.leftOut,
    quote,
    quoteValidMinutes: QUOTE_TTL_MINUTES,
  });
  return { status: 200, body, summary: body.message, headers: { "Cache-Control": "no-store" } };
}

/** GET /api/v1/packs/{id} and the get_pack tool. */
export async function getPack(ctx: ApiContext, id: string, options?: ServiceReadOptions): Promise<ApiResult> {
  if (!isUuid(id)) {
    return errorResult(404, "not_found", API_COPY.packNotFound);
  }
  const job = options
    ? await ctx.caller.services.getJob(ctx.caller.principal.workspaceId, id, options)
    : await ctx.caller.services.getJob(ctx.caller.principal.workspaceId, id);
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
      const download = file.downloadUrl ? await ctx.caller.services.getJobFileDownload(workspaceId, id, file.id, { report: "snapshot" }) : null;
      return {
        id: file.id,
        name: download?.filename ?? file.name,
        channel: file.channel,
        specId: file.specId,
        kind: file.kind,
        bytes: download?.bytes ?? file.bytes,
        url: download?.url ?? null,
        expiresAt: download?.url ? expiresAt : null,
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
 * marketplace checker, run with verified registry rules (Amazon by default).
 * Reads pixels only; nothing is stored and no credit is used. */
export async function checkMainImage(
  ctx: ApiContext,
  rawBody: unknown,
  options: { audience?: "api" | "assistant" } = {},
): Promise<ApiResult> {
  const limited = await overLimit("uploads.preflight", ctx.headers, ctx.caller);
  if (limited) {
    return limited;
  }
  if (missingAttachmentIn(rawBody, "image")) {
    return errorResult(NO_ATTACHMENT.status, NO_ATTACHMENT.reason, NO_ATTACHMENT.message);
  }
  const parsed = MainImageCheckRequest.safeParse(rawBody);
  if (!parsed.success) {
    return errorResult(400, "invalid_request", API_COPY.invalid, { issues: issuesOf(parsed.error) });
  }
  const channel = parsed.data.channel === undefined
    ? defaultCheckerChannel()
    : checkerChannels().find((entry) => entry.key === parsed.data.channel || entry.specId === parsed.data.channel);
  if (!channel) {
    return errorResult(400, "invalid_request", API_COPY.invalid);
  }
  // A link, base64 bytes, or the image attached in ChatGPT (P19-15). Through
  // /api/mcp (the assistant audience) a refusal carries the neutral photo
  // line; the REST route keeps the API copy.
  const assistant = options.audience === "assistant";
  const read = await readPhoto(parsed.data, ctx.photos, assistant ? { number: 1, audience: "assistant" } : {});
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
    return forAssistant(
      errorResult(422, "not_image", API_COPY.checkUnreadable),
      assistant ? MCP_COPY.photoUnreadable(1) : undefined,
    );
  }
  const checkerRules = channel.rules;
  flattenOnWhite(pixels.data);
  const rows = checkRows(
    { width: pixels.naturalWidth, height: pixels.naturalHeight },
    measurePixels(pixels.data, pixels.width, pixels.height),
    checkerRules,
  );
  return {
    status: 200,
    body: {
      channel: channel.key,
      spec_id: channel.specId,
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
