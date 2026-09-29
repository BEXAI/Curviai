/**
 * The public API v1 wire shapes the client speaks (PHASE_16 workstream 5).
 * Routes, relative to the base URL (default https://curvi.ai/api/v1):
 *
 *   POST /packs              create a pack (photo upload or URL, channels,
 *                            output options, bundle, answers)
 *   GET  /packs/{id}         the pack and its shots
 *   GET  /packs/{id}/files   the delivered files with short lived signed URLs
 *   POST /checks/main-image  the free Amazon main image checker
 *
 * Every request carries "Authorization: Bearer <workspace API key>". Every
 * POST carries an Idempotency-Key header.
 *
 * A photo from disk goes up as multipart/form-data: a "photo" file part and a
 * "request" part holding the JSON body below without photoUrl. A photo on the
 * web goes up as an application/json body with photoUrl.
 *
 * Errors are JSON { error, issues? } with the HTTP status; 429 and 503 carry
 * Retry-After in seconds.
 *
 * The fields below are the ones the CLI reads or sends. Responses may carry
 * more; the client passes them through untouched. Bundle, look and channel
 * values are passed as typed and validated by the server against the seed
 * and the spec registry (CLAUDE.md rule 2), so the client never goes stale.
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

/** The body of POST /packs (the multipart "request" part leaves out photoUrl). */
export interface CreatePackRequest {
  /** A public http(s) URL of the product photo; used when no file is sent. */
  photoUrl?: string;
  /** Channel spec ids from the registry, for example "amazon.main". */
  channels: string[];
  /** A seeded pack bundle key; the server default is everything. */
  bundle?: string;
  /** A seeded Look key; the server fills the output options from it. */
  look?: string;
  /** Output options as the web form sends them (PHASE_15), strict. */
  outputOptions?: Record<string, unknown>;
  /** The question step's answers by question kind (PHASE_16 workstream 4). */
  answers?: Record<string, string>;
  /** Listing Mode (default) or concept. */
  mode?: "listing" | "concept";
  /** Product title for a new product. */
  title?: string;
  /** The seller's note, the same field as the web form. */
  note?: string;
}

export interface PackShot {
  shotId: string;
  shotType: string;
  status: ShotStatus | string;
  channels: string[];
  credits: number;
  /** Plain spoken reason for a skipped or needs review shot. */
  note?: string | null;
}

export interface Pack {
  id: string;
  status: PackStatus | string;
  channels: string[];
  bundle?: string;
  creditsReserved: number;
  creditsCharged: number;
  createdAt: string;
  shots?: PackShot[];
  /** Plain spoken failure line when status is failed. */
  error?: string | null;
  /** The pack's page in the web app. */
  appUrl?: string | null;
}

export interface PackFile {
  id: string;
  name: string;
  /** Channel family, for example "amazon"; null for the pack level report. */
  channel: string | null;
  specId: string | null;
  kind: "image" | "zip" | "report" | string;
  bytes: number | null;
  /** Short lived signed URL; null when the file is not stored. */
  url: string | null;
  /** When url stops working, ISO 8601. */
  expiresAt?: string | null;
}

export interface PackFiles {
  packId: string;
  status: PackStatus | string;
  files: PackFile[];
  notice?: string;
}

export interface MainImageCheckRow {
  key: string;
  label: string;
  pass: boolean;
  measured: string;
}

export interface MainImageCheck {
  pass: boolean;
  rows: MainImageCheckRow[];
  summary: string;
}

export interface ApiErrorBody {
  error: string;
  issues?: string[];
}
