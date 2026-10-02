/**
 * LLM cost reporting for the health details (docs/phases/PHASE_17.md
 * workstream 6): LLM spend and tokens per provider over recent UTC days,
 * read from the usage counters the pipeline's LLM monitor keeps in
 * spend_cap_counters (trigger/src/llm-monitor.ts), and the OpenAI credit
 * window from the seed (founder decision 4: the credits expire on
 * 2026-12-31, reminders from 2026-12-01).
 */

import { sql } from "@curvi/db";
import { llmCreditWindows, type LlmCreditWindow } from "@curvi/pipeline/seed";
import {
  dueCreditReminder,
  daysUntil,
  inDaysText,
  lastUtcDays,
  llmFamilyName,
  llmSpendReportFromCounters,
  type LlmSpendReport,
} from "@curvi/trigger/llm-monitor";
import type { SqlExecutor } from "@/lib/service-health";

/** Days the health details report LLM spend for, today included. */
export const LLM_SPEND_REPORT_DAYS = 7;

/** postgres-js returns the rows as an array, PGlite as { rows }. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    return result as T[];
  }
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/** LLM spend per provider family and per recipe for the last days. */
export async function readLlmSpend(
  db: SqlExecutor,
  now: Date,
  dayCount: number = LLM_SPEND_REPORT_DAYS,
): Promise<LlmSpendReport> {
  const days = lastUtcDays(now, dayCount);
  const rows = rowsOf<{ key: string; total_micros: string | number }>(
    await db.execute(
      sql`select key, total_micros from spend_cap_counters
          where key like ${"llm|day|%"}
            and split_part(key, '|', 3) in (${sql.join(
              days.map((day) => sql`${day}`),
              sql`, `,
            )})`,
    ),
  );
  const counters = new Map<string, number>();
  for (const row of rows) {
    if (typeof row?.key === "string") counters.set(row.key, Number(row.total_micros));
  }
  return llmSpendReportFromCounters(counters, days);
}

/**
 * The credit window warnings due on now's UTC day: from the first reminder
 * date until the expiry, and after the expiry until the seed changes.
 */
export function llmCreditWarnings(
  now: Date,
  windows: readonly LlmCreditWindow[] = llmCreditWindows,
): Array<{ code: string; message: string }> {
  const day = now.toISOString().slice(0, 10);
  const warnings: Array<{ code: string; message: string }> = [];
  for (const window of windows) {
    const name = llmFamilyName(window.family);
    if (day > window.expiresOn) {
      warnings.push({
        code: `llm_credits_expired:${window.family}`,
        message: `The ${name} credits expired on ${window.expiresOn}. Check that ${name} is on paid usage, or make Claude the primary model again.`,
      });
    } else if (dueCreditReminder(window, day) !== null) {
      warnings.push({
        code: `llm_credits_expiring:${window.family}`,
        message: `The ${name} credits expire on ${window.expiresOn}, ${inDaysText(daysUntil(day, window.expiresOn))}. Decide whether to keep ${name} on paid usage or make Claude the primary model again.`,
      });
    }
  }
  return warnings;
}
