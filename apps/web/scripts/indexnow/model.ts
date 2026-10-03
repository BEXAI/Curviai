import { z } from "zod";

export const INDEXNOW_SITE = "https://curvi.ai";
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
export function indexNowKeyLocation(key: string): string {
  if (!/^[A-Za-z0-9-]{8,128}$/.test(key)) throw new Error("IndexNow ownership key format is invalid.");
  return `${INDEXNOW_SITE}/${key}.txt`;
}
export const MAX_URLS = 1_000;
export const MAX_BATCH = 100;
// Local operator limits, not a claim about a universal IndexNow quota.
export const DAILY_URL_ATTEMPTS = 500;
export const MAX_ATTEMPTS = 3;
export const URL_DEBOUNCE_MS = 5 * 60_000;
export const MAX_HISTORY = 200;

const timestamp = z.string().datetime();
export const outcomeSchema = z.enum([
  "baseline", "queued", "attempting", "accepted", "key_pending", "retryable", "failed", "unknown", "excluded",
]);
export type Outcome = z.infer<typeof outcomeSchema>;

export const entrySchema = z.object({
  url: z.string().url().max(2_048),
  kind: z.enum(["page", "deleted"]),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  lastmod: z.string().max(40).optional(),
  outcome: outcomeSchema,
  observedAt: timestamp,
  attemptCount: z.number().int().min(0).max(MAX_ATTEMPTS),
  lastAttemptAt: timestamp.optional(),
  nextAttemptAt: timestamp.optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  reason: z.string().max(100).optional(),
  // Receipt cannot establish indexing. Non-unknown values require an
  // explicitly recorded human observation from Bing Webmaster Tools.
  indexing: z.enum(["unknown", "indexed", "not_indexed"]),
  indexingObservedAt: timestamp.optional(),
  indexingSource: z.literal("operator_recorded_bing_inspection").optional(),
}).strict();
export type Entry = z.infer<typeof entrySchema>;

export const historySchema = z.object({
  at: timestamp,
  urls: z.array(z.string().url().max(2_048)).max(MAX_BATCH),
  outcome: outcomeSchema,
  httpStatus: z.number().int().min(100).max(599).optional(),
  reason: z.string().max(100).optional(),
}).strict();

export const stateSchema = z.object({
  version: z.literal(1),
  site: z.literal(INDEXNOW_SITE),
  initializedAt: timestamp,
  lastScanAt: timestamp,
  entries: z.array(entrySchema).max(MAX_URLS),
  budget: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), urlAttempts: z.number().int().min(0).max(DAILY_URL_ATTEMPTS) }).strict(),
  // An endpoint-wide Retry-After applies across runs and URL batches.
  blockedUntil: timestamp.optional(),
  history: z.array(historySchema).max(MAX_HISTORY),
}).strict();
export type IndexNowState = z.infer<typeof stateSchema>;

export function parseState(value: unknown): IndexNowState {
  const result = stateSchema.safeParse(value);
  if (!result.success) throw new Error("IndexNow state is invalid; preserve it and review before retrying.");
  if (new Set(result.data.entries.map((entry) => entry.url)).size !== result.data.entries.length) {
    throw new Error("IndexNow state contains duplicate URLs; preserve it and review before retrying.");
  }
  for (const entry of result.data.entries) {
    if (entry.indexing !== "unknown" && (!entry.indexingObservedAt || !entry.indexingSource)) {
      throw new Error("Indexing evidence is missing; preserve the state and review it.");
    }
  }
  return result.data;
}
