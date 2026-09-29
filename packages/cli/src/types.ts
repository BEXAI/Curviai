/**
 * The public API v1 wire shapes the client speaks (PHASE_16 workstream 5).
 * They mirror the server's zod schemas (apps/web/src/lib/api-v1/schemas.ts)
 * and its OpenAPI document (GET /api/v1/openapi.json); the web app's CLI end
 * to end test runs this client against the route handlers to hold them
 * together. Routes, relative to the base URL (default https://curvi.ai/api/v1):
 *
 *   POST /packs              createPack: start a pack (scope packs:write)
 *   GET  /packs/{id}         getPack: the pack and its shots (packs:read)
 *   GET  /packs/{id}/files   listPackFiles: signed, short lived links (packs:read)
 *   POST /checks/main-image  checkMainImage: the free main image checker (checks)
 *   GET  /channels           listChannels: specs and bundles for the plan (any key)
 *
 * Every request carries "Authorization: Bearer <workspace API key>". POST
 * /packs carries an Idempotency-Key header (required, at most 200
 * characters); the same key is reused on every retry.
 *
 * Bodies are JSON. Photos travel inside the body, as a public https link
 * ({ url }) or as base64 bytes ({ data }).
 *
 * Errors are JSON { error, reason, issues?, existingPackId?,
 * retryAfterSeconds? } with the HTTP status; 429 and 503 carry Retry-After in
 * seconds.
 *
 * Bundle, look and channel values are passed as typed and validated by the
 * server against the seed and the spec registry (CLAUDE.md rule 2), so the
 * client never goes stale.
 */

export type PackStatus =
  | "queued"
  | "analyzing"
  | "planning"
  | "generating"
  | "qc"
  | "packaging"
  | "done"
  | "failed"
  | "canceled";

export const TERMINAL_PACK_STATUSES: readonly PackStatus[] = ["done", "failed", "canceled"];

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_PACK_STATUSES as readonly string[]).includes(status);
}

export type ShotStatus = "pending" | "generating" | "qc" | "done" | "failed" | "needs_review" | "skipped";

/** What a photo shows, when it is not the front (the seller inputs' angle roles). */
export type PhotoAngle = string;

/** One photo in a request: a public https link or base64 bytes, not both. */
export type PhotoInput = ({ url: string; data?: never } | { data: string; url?: never }) & { angle?: PhotoAngle };

/** The body of POST /packs. Unknown fields are refused. */
export interface CreatePackRequest {
  /** Channel spec ids such as "amazon.main", or channel names such as
   * "amazon" for every live spec of that channel. */
  channels: string[];
  /** Real product photos, at most 8. */
  photos?: PhotoInput[];
  /** An existing product id, or "new" (the default). */
  productId?: string;
  /** The new product's title. */
  title?: string;
  /** The seller's note, the same field as the web form. */
  note?: string;
  sku?: string;
  boxContents?: string[];
  comparisonFacts?: string[];
  endorsements?: string[];
  /** A seeded pack bundle key; the server default is everything. */
  bundle?: string;
  /** A seeded look key; the server fills the output options from its preset. */
  look?: string;
  /** Output options as the web form sends them (PHASE_15), strict. Fields
   * sent here win over the look's preset. */
  outputOptions?: Record<string, unknown>;
}

export interface ShotCompliance {
  pass: boolean;
  fillPct: number | null;
  background: number[] | null;
}

export interface PackShot {
  id: string;
  type: string;
  status: ShotStatus;
  channels: string[];
  credits: number;
  /** Plain spoken reason for a skipped or needs review shot. */
  note: string | null;
  compliance: ShotCompliance | null;
}

export interface Pack {
  id: string;
  status: PackStatus;
  /** True once the pack stopped: done, failed or canceled. */
  finished: boolean;
  productId: string;
  productTitle: string;
  channels: string[];
  creditsReserved: number;
  creditsCharged: number;
  createdAt: string;
  /** Plain spoken failure line when status is failed. */
  error: string | null;
  shots: PackShot[];
  /** API paths of the pack and of its files. */
  links: { self: string; files: string };
}

/** The answer of POST /packs and GET /packs/{id}. */
export interface PackResponse {
  pack: Pack;
  /** True when POST /packs replayed an earlier request with the same key. */
  replayed?: boolean;
}

export interface PackFile {
  id: string;
  name: string;
  /** Channel family, for example "amazon"; null for the pack level report. */
  channel: string | null;
  specId: string | null;
  kind: "image" | "zip" | "report";
  bytes: number | null;
  /** Short lived signed URL; null when the file is not stored. */
  url: string | null;
  /** When url stops working, ISO 8601; null when there is no url. */
  expiresAt: string | null;
}

/** The answer of GET /packs/{id}/files. */
export interface PackFiles {
  packId: string;
  status: PackStatus;
  files: PackFile[];
  notice?: string;
}

/** The body of POST /checks/main-image: a link or base64 bytes, not both. */
export type MainImageCheckRequest = { url: string; data?: never } | { data: string; url?: never };

export interface MainImageCheckRow {
  key: "resolution" | "background" | "fill";
  label: string;
  pass: boolean;
  measured: string;
}

/** The answer of POST /checks/main-image. */
export interface MainImageCheck {
  pass: boolean;
  summary: string;
  width: number;
  height: number;
  checks: MainImageCheckRow[];
  rules: { minLongSide: number; fillMinPercent: number; fillMaxPercent: number };
}

export interface Channel {
  id: string;
  channel: string;
  name: string;
  width: number | null;
  height: number | null;
  availability: "available" | "coming_soon" | "upgrade_required";
  upgradeTo: string | null;
}

/** The answer of GET /channels. */
export interface ChannelsResponse {
  channels: Channel[];
  bundles: { key: string; label: string }[];
}

export interface ApiErrorBody {
  error: string;
  /** A stable machine readable reason, for example insufficient_credits. */
  reason: string;
  issues?: string[];
  /** On a 409 idempotency_conflict: the pack the key already started. */
  existingPackId?: string;
  retryAfterSeconds?: number;
}
