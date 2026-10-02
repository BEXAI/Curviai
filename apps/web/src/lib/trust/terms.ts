/**
 * Server side record of terms acceptance (migration 0015). Signup is a
 * clickwrap: the button sits above the Terms and Privacy notice. The browser
 * also puts terms_accepted_at in Supabase user metadata, but the user can
 * edit that value at will, so it proves nothing. The record that counts is a
 * terms_acceptances row the server writes with its own clock, the request IP
 * and the user agent:
 *
 * - at the signup confirmation link (/auth/callback), the first request the
 *   server sees after the user accepted by signing up;
 * - otherwise at the first signed in visit to /app, which covers accounts
 *   made before this table existed and sessions that never passed the
 *   callback;
 * - or at the first signed in visit to the ChatGPT consent page (PHASE_19
 *   P19-09), for a user who signs up there and never opens /app.
 *
 * Either way a row is written only when the user has no acceptance record at
 * all, so an existing user is never recorded as accepting a newer version
 * they were not shown. A new TERMS_VERSION therefore needs its own accept
 * step before it can be recorded.
 */

import { sql, type Db, type TermsAcceptanceSource } from "@curvi/db";
import { clientIp } from "@/lib/rate-limit";

/** Matches "Last updated October 2, 2026" on /terms. Change both together. */
export const TERMS_VERSION = "2026-10-02";

export interface TermsAcceptanceInput {
  userId: string;
  source: TermsAcceptanceSource;
  headers: Headers;
}

/** Users already known to have a record, so /app renders skip the write. */
const recorded = new Set<string>();
const RECORDED_CACHE_MAX = 10_000;

function rowsOf(result: unknown): unknown[] {
  return Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
}

/**
 * Writes the user's first acceptance record. Returns true when this call
 * wrote it. Concurrent first requests write once: the insert checks for any
 * existing row and the (user_id, version) unique index backs it up.
 */
export async function recordTermsAcceptance(db: Db, input: TermsAcceptanceInput): Promise<boolean> {
  if (recorded.has(input.userId)) {
    return false;
  }
  const ip = clientIp(input.headers);
  const userAgent = input.headers.get("user-agent")?.slice(0, 512) ?? null;
  const result = await db.execute(sql`
    insert into terms_acceptances (user_id, workspace_id, version, ip, user_agent, source)
    select
      ${input.userId}::uuid,
      (select workspace_id from members where user_id = ${input.userId}::uuid order by created_at limit 1),
      ${TERMS_VERSION},
      ${ip === "unknown" ? null : ip},
      ${userAgent},
      ${input.source}
    where not exists (select 1 from terms_acceptances where user_id = ${input.userId}::uuid)
    on conflict (user_id, version) do nothing
    returning id
  `);
  if (recorded.size >= RECORDED_CACHE_MAX) {
    recorded.clear();
  }
  recorded.add(input.userId);
  return rowsOf(result).length > 0;
}

/** Best effort wrapper for page and callback use: a failed write is logged
 * and retried on the next request, and never breaks the page. */
export async function recordTermsAcceptanceSafely(db: Db, input: TermsAcceptanceInput): Promise<void> {
  try {
    await recordTermsAcceptance(db, input);
  } catch (err) {
    console.error(`[terms] could not record terms acceptance for user ${input.userId}`, err);
  }
}

/** Test hook: forget which users were recorded. */
export function resetTermsCacheForTests(): void {
  recorded.clear();
}
