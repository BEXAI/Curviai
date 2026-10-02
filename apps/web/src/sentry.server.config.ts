/**
 * Sentry for the Node.js server runtime: route handlers, server components
 * and the inline pack runner (docs/phases/PHASE_20.md P20-13). Loaded once
 * by instrumentation.ts. Options and scrubbing live in lib/sentry; nothing
 * happens without SENTRY_DSN.
 *
 * With a DSN it also installs the second channel for founder alerts
 * (trigger/src/alert-report.ts), so a spend, quota or credit alert reaches
 * Sentry even when its email does not go out.
 */

import * as Sentry from "@sentry/nextjs";
import { setAlertReport } from "@curvi/trigger/alert-report";
import { sentryAlertReport } from "@/lib/sentry/alerts";
import { sentryInitOptions } from "@/lib/sentry/options";
import { addMcpLogSink } from "@/lib/api-v1/mcp-log";

const options = sentryInitOptions(process.env);
if (options) {
  Sentry.init(options);
  setAlertReport(sentryAlertReport);
  addMcpLogSink((entry) => {
    if (entry.level === "info") return;
    Sentry.captureMessage(`MCP ${entry.event}`, {
      level: entry.level === "error" ? "error" : "warning",
      tags: { surface: "mcp", reason: String(entry.fields.reason ?? entry.event) },
      extra: { ...entry.fields, error: entry.error },
    });
  });
}
