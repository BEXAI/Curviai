/**
 * Stale run reconciler (Update.md 3.1 and 3.2). Inline runs execute inside
 * the web process, so a deploy or restart orphans packs mid flight. The
 * runner heartbeats generation_jobs.updated_at on every state change, shot
 * attempt and stored asset, so a job that has not moved within the window
 * will never finish: it is failed and its credit hold is released.
 *
 * Callers run it workspace scoped whenever the workspace's jobs or balance
 * are read (a single job page, the recent jobs list and the credit balance),
 * so an orphaned hold never lingers on the dashboard until someone happens
 * to open that exact job.
 *
 * The UPDATE re-checks the status and the cutoff in SQL, so a run that
 * heartbeats or finishes between the read and the write is never clobbered,
 * and only the request that wins the update releases the credits. The worker
 * refuses to leave a terminal state, so a reconciled job stays failed.
 */

import { and, eq, generationJobs, lt, notInArray, sql, type Db } from "@curvi/db";

export const STALE_JOB_MS = 30 * 60 * 1000;
export const RECONCILED_JOB_ERROR = "The run was interrupted before finishing. Reserved credits were released.";

const TERMINAL: Array<"done" | "failed" | "canceled"> = ["done", "failed", "canceled"];

export interface ReconcileOptions {
  workspaceId: string;
  /** Limit the sweep to one job, for the single job page. */
  jobId?: string;
  now?: () => Date;
}

/** True when a job row looks orphaned and is worth a reconcile attempt. */
export function looksStale(job: { status: string; updatedAt: Date }, now: Date = new Date()): boolean {
  return !TERMINAL.includes(job.status as (typeof TERMINAL)[number]) && now.getTime() - job.updatedAt.getTime() > STALE_JOB_MS;
}

/**
 * Fails every stale job in the workspace (or the one job) and releases its
 * hold. Returns the ids this call reconciled. Never throws: a sweep failure
 * must not break the page that triggered it.
 */
export async function reconcileStaleJobs(db: Db, opts: ReconcileOptions): Promise<string[]> {
  const now = opts.now?.() ?? new Date();
  const staleBefore = new Date(now.getTime() - STALE_JOB_MS);
  const conditions = and(
    eq(generationJobs.workspaceId, opts.workspaceId),
    opts.jobId ? eq(generationJobs.id, opts.jobId) : undefined,
    notInArray(generationJobs.status, TERMINAL),
    lt(generationJobs.updatedAt, staleBefore),
  );
  try {
    // A cheap read first: almost every call finds nothing to do, and a read
    // takes no row locks.
    const candidates = await db.select({ id: generationJobs.id }).from(generationJobs).where(conditions).limit(1);
    if (candidates.length === 0) {
      return [];
    }
    const reconciled = await db
      .update(generationJobs)
      .set({ status: "failed", error: RECONCILED_JOB_ERROR, updatedAt: now })
      .where(conditions)
      .returning({ id: generationJobs.id });
    for (const { id } of reconciled) {
      try {
        await db.execute(sql`select release_credits(${opts.workspaceId}::uuid, ${id}::uuid)`);
      } catch (err) {
        console.error(`[jobs] could not release credits for reconciled job ${id}`, err);
      }
    }
    return reconciled.map((r) => r.id);
  } catch (err) {
    console.error(`[jobs] stale job sweep failed for workspace ${opts.workspaceId}`, err);
    return [];
  }
}
