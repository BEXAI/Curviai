/**
 * Settling a job the runner will not finish: a crash, a time cap, a
 * shutdown, a seller's cancel or the stale run reconciler. Kept apart from
 * enqueue.ts so the reconciler shares the delivered rule without pulling in
 * next/server.
 */

import { and, assets, eq, generationJobs, notInArray, sql, type Db } from "@curvi/db";

export type SettleOutcome = "failed" | "done" | "already_final";

/** What a settle did: the status it set (null when the job was already
 * terminal) and the credits release_credits returned to the balance. */
export interface SettleResult {
  status: "done" | "failed" | "canceled" | null;
  releasedCredits: number;
}

const TERMINAL_JOB_STATES = ["done", "failed", "canceled"] as const;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A charge the pack runner owes for a delivered asset. */
export interface DeliveredCharge {
  shotId: string;
  credits: number;
}

/**
 * The approved assets of a job whose files were delivered, with the credits
 * and shot id the runner charges them under. savePack writes an
 * asset_variants row for every file it uploads, before the compliance
 * report row, so an approved asset without a variant was left out of the
 * pack (for example past a channel's image limit) and is never charged.
 * One charge per shot id, the ledger's idempotency key.
 */
export async function deliveredCharges(db: Db | Tx, job: { jobId: string; workspaceId: string }): Promise<DeliveredCharge[]> {
  const rows = await db
    .select({ qc: assets.qc })
    .from(assets)
    .where(
      and(
        eq(assets.jobId, job.jobId),
        eq(assets.workspaceId, job.workspaceId),
        eq(assets.approved, true),
        sql`exists (select 1 from asset_variants v where v.asset_id = ${assets.id})`,
      ),
    )
    .orderBy(assets.createdAt);
  const charges = new Map<string, number>();
  for (const { qc } of rows) {
    const shotId = qc && typeof qc.shotId === "string" && qc.shotId.length > 0 ? qc.shotId : null;
    const credits = qc && typeof qc.credits === "number" && Number.isFinite(qc.credits) ? qc.credits : 0;
    if (shotId && credits > 0 && !charges.has(shotId)) {
      charges.set(shotId, credits);
    }
  }
  return [...charges].map(([shotId, credits]) => ({ shotId, credits }));
}

/**
 * The failure path for a job the inline runner will not finish: a crash
 * before the runner's own failure handling could act, a run past its time
 * cap, or a shutdown.
 *
 * - A job that already reached a terminal state is left as it is.
 * - A job whose pack was already delivered (savePack writes the compliance
 *   report row last) is marked done, and every approved asset whose files
 *   were delivered is charged with charge_credits under its shot id. The
 *   runner writes the report row before it charges, so a stop between the
 *   two would otherwise hand over a paid pack for free. charge_credits is
 *   idempotent per shot id, so charges the runner already made are skipped.
 * - Anything else is marked failed with `error`.
 *
 * release_credits then returns whatever the ledger still holds for the job;
 * it releases nothing when nothing is held, so calling it for an already
 * settled job is harmless.
 *
 * Everything runs in one transaction, so a crash part way never leaves a
 * job marked done with its credits still held. The workspace row is locked
 * first, the same order charge_credits and reserve_credits use, so a runner
 * charging this job at the same moment waits instead of deadlocking. The
 * status change is conditional, so a run that finishes at the same moment
 * is never overwritten.
 */
export async function settleInterruptedJob(
  db: Db,
  job: { jobId: string; workspaceId: string; runKey?: string },
  error: string,
): Promise<SettleOutcome> {
  const { status } = await settleJob(db, job, {
    undelivered: "failed", error,
    onlyIf: job.runKey ? eq(generationJobs.runKey, job.runKey) : undefined,
  });
  return status === "done" || status === "failed" ? status : "already_final";
}

/**
 * The settle behind settleInterruptedJob and the seller's cancel (POST
 * /api/jobs/[id]/cancel): a delivered pack is marked done and its delivered
 * files charged, anything else takes the `undelivered` status, and
 * release_credits returns whatever the job still holds. See
 * settleInterruptedJob for the locking and the guarantees.
 */
export async function settleJob(
  db: Db,
  job: { jobId: string; workspaceId: string },
  opts: {
    undelivered: "failed" | "canceled";
    error: string | null;
    /** An extra condition the status change must also meet, re-checked in
     * the same UPDATE (the stale reconciler passes its cutoff). */
    onlyIf?: Parameters<typeof and>[number];
    now?: Date;
  },
): Promise<SettleResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from workspaces where id = ${job.workspaceId}::uuid for update`);
    const delivered = sql`exists (select 1 from pack_files pf where pf.job_id = ${job.jobId}::uuid and pf.kind = 'report')`;
    const rows = await tx
      .update(generationJobs)
      .set({
        status: sql`case when ${delivered} then 'done' else ${opts.undelivered}::text end`,
        error: sql`case when ${delivered} then ${generationJobs.error} else ${opts.error}::text end`,
        // A fresh run key that no runner holds: the run this settle stopped
        // is refused at its next check even after a newer follow up moves
        // the job back to generating under a key of its own (0019).
        runKey: sql`gen_random_uuid()::text`,
        updatedAt: opts.now ?? new Date(),
        finishedAt: opts.now ?? new Date(),
        runnerId: null,
        heartbeatAt: null,
        restartPayload: opts.undelivered === "failed" ? sql`case when ${delivered} then null else ${generationJobs.restartPayload} end` : null,
      })
      .where(
        and(
          eq(generationJobs.id, job.jobId),
          eq(generationJobs.workspaceId, job.workspaceId),
          notInArray(generationJobs.status, [...TERMINAL_JOB_STATES]),
          opts.onlyIf,
        ),
      )
      .returning({ status: generationJobs.status });
    const status = rows[0]?.status;
    if (!status && opts.onlyIf) {
      // The job moved (a heartbeat, or another settle won): a job that is
      // still live keeps its hold.
      return { status: null, releasedCredits: 0 };
    }

    if (status === "done") {
      for (const charge of await deliveredCharges(tx, job)) {
        try {
          // A savepoint per charge: one charge the ledger refuses (it would
          // exceed the hold) is logged and skipped instead of rolling back
          // the whole settle and leaving the job stuck.
          await tx.transaction(async (sp) => {
            await sp.execute(
              sql`select charge_credits(${job.workspaceId}::uuid, ${charge.credits}::numeric, ${job.jobId}::uuid, ${charge.shotId}::text)`,
            );
          });
        } catch (err) {
          console.error(
            `[jobs] could not charge ${charge.credits} credits for shot ${charge.shotId} of delivered job ${job.jobId}`,
            err,
          );
        }
      }
    }

    const released = await tx.execute(
      sql`select release_credits(${job.workspaceId}::uuid, ${job.jobId}::uuid) as released`,
    );
    return {
      status: status === "done" || status === "failed" || status === "canceled" ? status : null,
      releasedCredits: firstNumber(released, "released"),
    };
  });
}

/** One numeric column of the first row of a raw query. postgres-js returns
 * the rows array; other drivers wrap it in { rows }. */
function firstNumber(result: unknown, column: string): number {
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<
    Record<string, unknown>
  >;
  const value = Number(rows[0]?.[column] ?? 0);
  return Number.isFinite(value) ? value : 0;
}
