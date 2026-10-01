/**
 * Weekly metrics digest cron: Mondays 08:00 America/New_York
 * (CURVI_BUILD_PLAN.md section 8). Assembles MRR, churn, COGS and margin
 * from an injected metrics reader, adds LLM spend per provider for the last
 * 7 days from the LLM usage counters when a database is set, and sends via
 * the Resend REST API with plain fetch. Envless behavior: the digest is composed from the demo
 * reader and the send step returns a setup notice instead of sending.
 */

import { schedules } from "@trigger.dev/sdk/v3";
import {
  composeDigest,
  DemoMetricsReader,
  sendDigestEmail,
  type DigestEmail,
  type DigestSendResult,
  type MetricsReader,
} from "../digest";
import { PgCapStore } from "../cap-store";
import { getWorkerDb } from "../db-runtime";
import { lastUtcDays, llmSpendReport } from "../llm-monitor";
import { optionalEnv } from "../runtime";

/** Days of LLM spend the weekly digest reports. */
const LLM_SPEND_DAYS = 7;

export interface MetricsDigestRunResult extends DigestSendResult {
  email: DigestEmail;
}

export const metricsDigest = schedules.task({
  id: "metrics-digest",
  cron: { pattern: "0 8 * * 1", timezone: "America/New_York" },
  run: async (payload): Promise<MetricsDigestRunResult> => {
    const month = payload.timestamp.toISOString().slice(0, 7);
    const reader: MetricsReader = new DemoMetricsReader(month);
    const metrics = await reader.read();
    // LLM spend per provider from the shared usage counters (PHASE_17.md
    // workstream 6). Without a database, or when the read fails, the digest
    // goes out without it.
    const databaseUrl = optionalEnv("DATABASE_URL");
    if (databaseUrl) {
      try {
        const report = await llmSpendReport(
          new PgCapStore(getWorkerDb(databaseUrl)),
          lastUtcDays(payload.timestamp, LLM_SPEND_DAYS),
        );
        metrics.llmSpend = { days: report.days, byFamily: report.byFamily };
      } catch (err) {
        console.warn("[metrics-digest] could not read the LLM spend counters:", err instanceof Error ? err.message : err);
      }
    }
    const email = composeDigest(metrics);
    const result = await sendDigestEmail(email, {
      apiKey: optionalEnv("RESEND_API_KEY"),
      to: optionalEnv("METRICS_DIGEST_TO"),
      from: optionalEnv("METRICS_DIGEST_FROM"),
    });
    return { email, ...result };
  },
});
