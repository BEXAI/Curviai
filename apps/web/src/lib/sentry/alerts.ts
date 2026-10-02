/**
 * Founder alerts in Sentry (docs/phases/PHASE_20.md P20-13): the second
 * channel the trigger notifiers hand every alert to (trigger/src/alert-
 * report.ts). Installed by sentry.server.config.ts only when a DSN is set.
 *
 * Each alert's fingerprint holds its kind and its period (the UTC day or
 * hour the notifier deduplicates on), so every new alert opens a new Sentry
 * issue and the new issue email goes out, while a retry of the same alert
 * joins its issue.
 */

import * as Sentry from "@sentry/nextjs";
import type { AlertLevel, AlertTags } from "@curvi/trigger/alert-report";

export function sentryAlertReport(message: string, tags: AlertTags, level: AlertLevel = "warning"): void {
  Sentry.captureMessage(message, {
    level,
    tags: { ...tags, source: "founder_alert" },
    fingerprint: ["founder-alert", tags.alert ?? "unknown", tags.period ?? ""],
  });
}
