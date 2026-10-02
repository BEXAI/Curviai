/**
 * The store image audit's site wide daily cap (P18-18): at most
 * storeAudit.auditsPerDay audits per UTC day across every visitor, so a
 * crowd of addresses cannot turn the free tool into a crawler. It counts in
 * the same store as the request rate limits (Upstash when configured, one
 * counter per process otherwise), keyed by the UTC day so a counter never
 * outlives its day.
 */

import { anonymousSpendLimits } from "@/lib/anonymous-spend";
import { getRateLimitStore, type RateLimitStore } from "@/lib/rate-limit";

const DAY_MS = 24 * 3600 * 1000;

export interface DailyCapDecision {
  allowed: boolean;
  /** Seconds until the UTC day ends. */
  retryAfterSeconds: number;
}

/** Counts one audit against today's cap. */
export async function takeDailyAudit(
  options: { store?: RateLimitStore; nowMs?: number; limit?: number } = {},
): Promise<DailyCapDecision> {
  const nowMs = options.nowMs ?? Date.now();
  const day = Math.floor(nowMs / DAY_MS);
  const resetAt = (day + 1) * DAY_MS;
  const count = await (options.store ?? getRateLimitStore()).increment(
    `store-audit:daily:${day}`,
    resetAt - nowMs,
    nowMs,
  );
  return {
    allowed: count <= (options.limit ?? anonymousSpendLimits().storeAuditsPerDay),
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - nowMs) / 1000)),
  };
}
