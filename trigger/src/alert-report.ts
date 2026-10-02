/**
 * The second channel for founder alerts (docs/phases/PHASE_20.md P20-13).
 *
 * Every founder alert (spend-alerts.ts, llm-monitor.ts, provider-quota.ts)
 * goes out by email first. Email can fail (no sender set up, Resend down),
 * so each alert is also handed to this hook. trigger/src stays free of
 * Sentry: the web app installs the hook once at startup
 * (apps/web/src/sentry.server.config.ts, only when SENTRY_DSN is set) and
 * every notifier reads it through reportAlert. Without a hook, reporting is
 * a no op.
 *
 * The hook lives on globalThis because Next.js bundles route handlers and
 * the instrumentation file separately, and one process must share one hook.
 * A hook that throws never breaks an alert.
 */

export type AlertLevel = "error" | "warning" | "info";

/** Short stable tags: `alert` names the kind, `period` the day or hour the
 * alert is deduplicated on, plus details such as the provider. Never a
 * secret or an env value. */
export type AlertTags = Record<string, string>;

export type AlertReport = (message: string, tags: AlertTags, level?: AlertLevel) => void;

const reportScope = globalThis as typeof globalThis & { __curviAlertReport?: AlertReport | null };

/** Installs the process wide hook, or removes it with null. */
export function setAlertReport(report: AlertReport | null): void {
  reportScope.__curviAlertReport = report;
}

/** True when a hook is installed. */
export function hasAlertReport(): boolean {
  return typeof reportScope.__curviAlertReport === "function";
}

/** Hands one alert to the installed hook. Never throws. */
export const reportAlert: AlertReport = (message, tags, level = "warning") => {
  const report = reportScope.__curviAlertReport;
  if (!report) {
    return;
  }
  try {
    report(message, tags, level);
  } catch {
    // The second channel is best effort; the email and the log line stand.
  }
};

/** Calls an injected hook, or the process wide one, and never throws. */
export function sendAlertReport(
  report: AlertReport | undefined,
  message: string,
  tags: AlertTags,
  level: AlertLevel = "warning",
): void {
  try {
    (report ?? reportAlert)(message, tags, level);
  } catch {
    // Best effort, as above.
  }
}
