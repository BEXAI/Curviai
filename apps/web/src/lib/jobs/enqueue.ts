/**
 * The bridge from POST /api/jobs to the worker (audit P0 finding 1). With
 * TRIGGER_SECRET_KEY set, the job goes to the Trigger.dev generate-pack task.
 * Without it, the pack runs inline in this process after the response
 * flushes, using the same runner and the same database backed store, so local
 * and small scale db deployments work end to end without a worker account.
 *
 * Inline packs go through the process wide InlinePackRunner: a concurrency
 * limit (CURVI_INLINE_PACK_CONCURRENCY) with waiting jobs queued in order, a
 * wall clock cap per run (CURVI_INLINE_PACK_MAX_RUN_MS, 25 minutes by
 * default) so one hung pack cannot hold the queue, and a SIGTERM drain that
 * settles every job it cannot finish, so a deploy never leaves a job stuck
 * with its credits held.
 */

import { after } from "next/server";
import type { PackFollowUpInput } from "@curvi/trigger/follow-up";
import type { GeneratePackInput } from "@curvi/trigger/runner";
import { and, assets, eq, generationJobs, notInArray, sql, type Db } from "@curvi/db";
import { optionalEnv } from "@/lib/env";
import {
  InlinePackRunner,
  installInlinePackRunner,
  readInlineRunnerConfig,
  type SettleReason,
} from "./inline-runner";

export type EnqueueMode = "trigger" | "inline";

/** What the inline runner queues: a first pack run or a pack follow up (a
 * retried shot or an added angle on a delivered pack). */
export type InlineRunPayload = GeneratePackInput | PackFollowUpInput;

function isFollowUp(payload: InlineRunPayload): payload is PackFollowUpInput {
  return (payload as { kind?: unknown }).kind === "follow_up";
}

export async function enqueueGeneratePack(payload: GeneratePackInput): Promise<EnqueueMode> {
  if (optionalEnv("TRIGGER_SECRET_KEY")) {
    const { tasks } = await import("@trigger.dev/sdk/v3");
    await tasks.trigger("generate-pack", payload, {
      idempotencyKey: `generate-pack:${payload.jobId}`,
    });
    return "trigger";
  }

  const runner = getInlinePackRunner();
  // A draining instance takes no new work. The throw sends the caller down
  // its existing failure path, which marks the job failed and releases the
  // hold before the response goes out.
  runner.assertAccepting();
  // submit never rejects and resolves once the job is finished or settled;
  // after() keeps Next.js from exiting on SIGTERM until that happens.
  after(() => runner.submit(payload));
  return "inline";
}

/**
 * Queues a pack follow up, on Trigger.dev when it is configured and inline
 * otherwise, exactly like a first run. The caller already holds the credits
 * and moved the job back to generating; a throw here is the caller's cue to
 * return the hold.
 */
export async function enqueuePackFollowUp(payload: PackFollowUpInput): Promise<EnqueueMode> {
  if (optionalEnv("TRIGGER_SECRET_KEY")) {
    const { tasks } = await import("@trigger.dev/sdk/v3");
    await tasks.trigger("pack-follow-up", payload, {
      idempotencyKey: `pack-follow-up:${payload.runKey}`,
    });
    return "trigger";
  }
  const runner = getInlinePackRunner();
  runner.assertAccepting();
  after(() => runner.submit(payload));
  return "inline";
}

/** Error text the job board shows for a job the inline runner settled. Plain
 * spoken, no dashes (CLAUDE.md rule 9). */
export const SETTLED_JOB_MESSAGES: Record<SettleReason, string> = {
  crashed: "The pack run stopped because of an internal error. Reserved credits were released.",
  not_started:
    "The server restarted before this pack could start. Reserved credits were released, so you can run it again.",
  interrupted:
    "The server restarted while this pack was running. Reserved credits were released, so you can run it again.",
  timed_out:
    "This pack took longer than the time limit, so it was stopped. Reserved credits were released, so you can run it again.",
};

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
  job: { jobId: string; workspaceId: string },
  error: string,
): Promise<SettleOutcome> {
  const { status } = await settleJob(db, job, { undelivered: "failed", error });
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
  opts: { undelivered: "failed" | "canceled"; error: string | null },
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
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(generationJobs.id, job.jobId),
          eq(generationJobs.workspaceId, job.workspaceId),
          notInArray(generationJobs.status, [...TERMINAL_JOB_STATES]),
        ),
      )
      .returning({ status: generationJobs.status });
    const status = rows[0]?.status;

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

/** Bumps updated_at on jobs that are still queued, so jobs waiting for an
 * inline slot never look stale to the reconciler. Started or finished jobs
 * are left alone. */
export async function heartbeatQueuedJobs(db: Db, jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) {
    return;
  }
  const idArray = `{${jobIds.join(",")}}`;
  await db
    .update(generationJobs)
    .set({ updatedAt: new Date() })
    .where(and(sql`${generationJobs.id} = any(${idArray}::uuid[])`, eq(generationJobs.status, "queued")));
}

async function appDb(): Promise<Db> {
  const { getDb } = await import("@/lib/services/db");
  return getDb();
}

function createInlinePackRunner(): InlinePackRunner<InlineRunPayload> {
  return new InlinePackRunner<InlineRunPayload>(readInlineRunnerConfig(optionalEnv), {
    runPack: async (payload) => {
      const { resolveRuntimeDeps } = await import("@curvi/trigger/db-runtime");
      if (isFollowUp(payload)) {
        // A follow up settles its own hold and always returns the job to
        // done. A crash is settled like a first run: the pack's report row
        // exists, so the job is marked done and delivered files are charged.
        const { runPackFollowUp } = await import("@curvi/trigger/follow-up");
        await runPackFollowUp(payload, resolveRuntimeDeps());
        return;
      }
      const { runGeneratePack } = await import("@curvi/trigger/runner");
      // runGeneratePack owns failure handling: it marks the job failed and
      // releases the remaining hold through the store. A throw out of it is a
      // crash, which the runner settles through settleInterruptedJob.
      await runGeneratePack(payload, resolveRuntimeDeps());
    },
    settle: async (payload, reason) => {
      const outcome = await settleInterruptedJob(await appDb(), payload, SETTLED_JOB_MESSAGES[reason]);
      console.warn(`[jobs] settled job ${payload.jobId} after ${reason}: ${outcome}`);
    },
    heartbeat: async (jobIds) => heartbeatQueuedJobs(await appDb(), jobIds),
  });
}

/** The process wide inline runner, with SIGTERM and SIGINT hooked to its
 * drain. Next.js exits by itself once the after() work resolves, unless
 * NEXT_MANUAL_SIG_HANDLE turns its own signal handling off. */
export function getInlinePackRunner(): InlinePackRunner<InlineRunPayload> {
  return installInlinePackRunner(createInlinePackRunner, {
    handleSignals: true,
    exitAfterShutdown: Boolean(optionalEnv("NEXT_MANUAL_SIG_HANDLE")),
  });
}
