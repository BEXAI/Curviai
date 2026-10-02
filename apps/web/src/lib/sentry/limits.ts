/**
 * Keeps error reporting inside Sentry's free 5k errors a month
 * (docs/phases/PHASE_20.md P20-13, founder decision 13). Two limits, both
 * from the seed (errorReporting in packages/pipeline/src/seed/monitoring.ts):
 * - the same error (by fingerprint) at most maxSameErrorPerHour times in
 *   any hour, so a hot loop during a provider outage sends a sample, not
 *   thousands;
 * - every error together at most maxEventsPerHour in any hour and
 *   maxEventsPerDay in any 24 hours, so the month cannot run out.
 * Windows slide and live in this process: a restart starts them again,
 * which can only send more, never hide the first error after a crash.
 * Founder alerts never depend on Sentry; email stays the first channel.
 */

import type { ErrorReportingLimits } from "@curvi/pipeline/seed";
import type { ErrorEvent } from "@sentry/nextjs";

export type LimitVerdict = "send" | "same_error_limit" | "hourly_limit" | "daily_limit";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_FINGERPRINT_LENGTH = 300;

/** Message and exception text with ids and numbers taken out, so "job 12"
 * and "job 34" count as the same error. */
export function normalizeErrorText(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FINGERPRINT_LENGTH);
}

/**
 * The key the repeat limit counts by: an explicit fingerprint when the
 * event has one; otherwise the exception type, its normalized message and
 * the innermost frame; otherwise the normalized message.
 */
export function eventFingerprint(event: ErrorEvent): string {
  const explicit = event.fingerprint?.filter((part) => part !== "{{ default }}") ?? [];
  if (explicit.length > 0 && explicit.length === event.fingerprint?.length) {
    return `fingerprint|${explicit.join("|")}`;
  }
  const values = event.exception?.values ?? [];
  const exception = values[values.length - 1];
  if (exception) {
    const frames = exception.stacktrace?.frames ?? [];
    const top = frames[frames.length - 1];
    const where = top ? `${top.module ?? top.filename ?? ""}:${top.function ?? ""}` : "";
    return ["exception", exception.type ?? "", normalizeErrorText(exception.value ?? ""), where].join("|");
  }
  const message = event.logentry?.message ?? event.message ?? "";
  return `message|${event.level ?? ""}|${normalizeErrorText(message)}`;
}

export class ErrorEventLimiter {
  /** Send times of every event in the last day, oldest first. */
  private readonly sent: number[] = [];
  /** Send times per fingerprint in the last hour, oldest first. */
  private readonly byFingerprint = new Map<string, number[]>();
  private readonly dropped = new Map<Exclude<LimitVerdict, "send">, number>();

  constructor(
    private readonly limits: ErrorReportingLimits,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether an event with this fingerprint may be sent now; a "send"
   * verdict counts it. */
  check(fingerprint: string): LimitVerdict {
    const now = this.now();
    this.prune(now);
    const same = this.byFingerprint.get(fingerprint) ?? [];
    let verdict: LimitVerdict = "send";
    if (same.length >= this.limits.maxSameErrorPerHour) {
      verdict = "same_error_limit";
    } else if (this.sent.length >= this.limits.maxEventsPerDay) {
      verdict = "daily_limit";
    } else if (this.countSince(now - HOUR_MS) >= this.limits.maxEventsPerHour) {
      verdict = "hourly_limit";
    }
    if (verdict !== "send") {
      this.dropped.set(verdict, (this.dropped.get(verdict) ?? 0) + 1);
      return verdict;
    }
    same.push(now);
    this.byFingerprint.set(fingerprint, same);
    this.sent.push(now);
    return verdict;
  }

  /** Events dropped by each limit since this process started. */
  droppedCounts(): Record<Exclude<LimitVerdict, "send">, number> {
    return {
      same_error_limit: this.dropped.get("same_error_limit") ?? 0,
      hourly_limit: this.dropped.get("hourly_limit") ?? 0,
      daily_limit: this.dropped.get("daily_limit") ?? 0,
    };
  }

  private countSince(since: number): number {
    let count = 0;
    for (let i = this.sent.length - 1; i >= 0 && this.sent[i] > since; i -= 1) count += 1;
    return count;
  }

  private prune(now: number): void {
    while (this.sent.length > 0 && this.sent[0] <= now - DAY_MS) this.sent.shift();
    for (const [fingerprint, times] of this.byFingerprint) {
      while (times.length > 0 && times[0] <= now - HOUR_MS) times.shift();
      if (times.length === 0) this.byFingerprint.delete(fingerprint);
    }
  }
}
