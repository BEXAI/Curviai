/**
 * Error reports for the inline pack runner (docs/phases/PHASE_20.md P20-13).
 *
 * lib/jobs/enqueue.ts runs each job (its start, its run, its time cap timer
 * and the runner's log lines about it, through the runner's inJobContext)
 * and each settle inside withJobScope, so every event from that work carries
 * the job's tags: job_id, workspace_id, run_key and run_kind. The scope
 * follows the work across awaits and timers (Sentry forks it through async
 * context).
 *
 * What reaches Sentry, once per run:
 * - a crash (the pack run threw while the runner still owned it): the
 *   runner's own console.error line with the exception, an error, through
 *   the console capture;
 * - a run past its time cap: the runner's console.error line, an error;
 * - a run a shutdown interrupted, or a waiting run a shutdown settled
 *   before it started: reportSettledJob, a warning (the runner logs no
 *   error for those);
 * - a settle that failed: reportSettleFailure, the exception as an error,
 *   before the runner logs the same error object (sent once).
 * Without a DSN every call here is a no op.
 */

import * as Sentry from "@sentry/nextjs";
import type { SeverityLevel } from "@sentry/nextjs";

/** What a job tag set is built from: a first run or a follow up payload. */
export interface JobScopePayload {
  jobId: string;
  workspaceId: string;
  runKey?: string;
  kind?: unknown;
}

/** The reasons the inline runner settles a job (lib/jobs/inline-runner.ts). */
export type JobSettleReason = "crashed" | "not_started" | "interrupted" | "timed_out";

export function jobTags(payload: JobScopePayload): Record<string, string> {
  return {
    job_id: payload.jobId,
    workspace_id: payload.workspaceId,
    run_key: payload.runKey ?? payload.jobId,
    run_kind: payload.kind === "follow_up" ? "follow_up" : "pack",
  };
}

/** Runs work with the job's tags on every event it reports. */
export function withJobScope<T>(payload: JobScopePayload, work: () => T): T {
  return Sentry.withScope((scope) => {
    scope.setTags(jobTags(payload));
    return work();
  });
}

/** The settle reasons the runner logs no error for: a shutdown's. A crash
 * and a time cap are already errors from the runner's own log lines, so
 * their settle adds nothing. */
export type ShutdownSettleReason = Extract<JobSettleReason, "interrupted" | "not_started">;

/** The level each shutdown settle is reported at. */
export const SETTLE_REPORT_LEVELS: Record<ShutdownSettleReason, SeverityLevel> = {
  interrupted: "warning",
  not_started: "warning",
};

/** Internal messages, for the founder in Sentry. */
export const SETTLE_REPORT_MESSAGES: Record<ShutdownSettleReason, string> = {
  interrupted: "A shutdown interrupted a running pack and settled it",
  not_started: "A shutdown settled a pack before it started",
};

/** Reports a job a shutdown settled; a crash or a time cap was already
 * reported by the runner's own error line. */
export function reportSettledJob(payload: JobScopePayload, reason: JobSettleReason): void {
  if (reason !== "interrupted" && reason !== "not_started") {
    return;
  }
  withJobScope(payload, () => {
    Sentry.captureMessage(SETTLE_REPORT_MESSAGES[reason], {
      level: SETTLE_REPORT_LEVELS[reason],
      tags: { settle_reason: reason },
      fingerprint: ["inline-runner", reason],
    });
  });
}

/** Reports a settle that failed: the job may still hold its credits until
 * the stale run reconciler finds it. */
export function reportSettleFailure(payload: JobScopePayload, reason: JobSettleReason, error: unknown): void {
  withJobScope(payload, () => {
    Sentry.captureException(error, { level: "error", tags: { settle_reason: reason, settle_failed: "true" } });
  });
}
