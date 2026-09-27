/**
 * Weekly metrics digest cron: Mondays 08:00 America/New_York
 * (CURVI_BUILD_PLAN.md section 8). Assembles MRR, churn, COGS and margin
 * from an injected metrics reader and sends via the Resend REST API with
 * plain fetch. Envless behavior: the digest is composed from the demo
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
import { optionalEnv } from "../runtime";

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
    const email = composeDigest(metrics);
    const result = await sendDigestEmail(email, {
      apiKey: optionalEnv("RESEND_API_KEY"),
      to: optionalEnv("METRICS_DIGEST_TO"),
      from: optionalEnv("METRICS_DIGEST_FROM"),
    });
    return { email, ...result };
  },
});
