/**
 * The bridge from POST /api/jobs to the worker (audit P0 finding 1). With
 * TRIGGER_SECRET_KEY set, the job goes to the Trigger.dev generate-pack task.
 * Without it, the pack runs inline in this process after the response
 * flushes, using the same runner and the same database backed store, so local
 * and small scale db deployments work end to end without a worker account.
 *
 * Inline packs go through the process wide InlinePackRunner: a concurrency
 * limit (CURVI_INLINE_PACK_CONCURRENCY) with waiting jobs queued in order,
 * and a SIGTERM drain that settles every job it cannot finish, so a deploy
 * never leaves a job stuck with its credits held.
 */

import { after } from "next/server";
import type { GeneratePackInput } from "@curvi/trigger/runner";
import { and, eq, generationJobs, notInArray, sql, type Db } from "@curvi/db";
import { optionalEnv } from "@/lib/env";
import {
  InlinePackRunner,
  installInlinePackRunner,
  readInlineRunnerConfig,
  type SettleReason,
} from "./inline-runner";

export type EnqueueMode = "trigger" | "inline";

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

/** Error text the job board shows for a job the inline runner settled. Plain
 * spoken, no dashes (CLAUDE.md rule 9). */
export const SETTLED_JOB_MESSAGES: Record<SettleReason, string> = {
  crashed: "The pack run stopped because of an internal error. Reserved credits were released.",
  not_started:
    "The server restarted before this pack could start. Reserved credits were released, so you can run it again.",
  interrupted:
    "The server restarted while this pack was running. Reserved credits were released, so you can run it again.",
};

export type SettleOutcome = "failed" | "done" | "already_final";

const TERMINAL_JOB_STATES = ["done", "failed", "canceled"] as const;

/**
 * The failure path for a job the inline runner will not finish: a crash
 * before the runner's own failure handling could act, or a shutdown.
 *
 * - A job that already reached a terminal state is left as it is.
 * - A job whose pack was already delivered (savePack writes the compliance
 *   report row last) is marked done: its files are downloadable and only the
 *   assets charged so far are paid for.
 * - Anything else is marked failed with `error`.
 *
 * The status change is one conditional statement, so a run that finishes at
 * the same moment is never overwritten. release_credits then returns whatever
 * the ledger still holds for the job; it releases nothing when nothing is
 * held, so calling it for an already settled job is harmless.
 */
export async function settleInterruptedJob(
  db: Db,
  job: { jobId: string; workspaceId: string },
  error: string,
): Promise<SettleOutcome> {
  const delivered = sql`exists (select 1 from pack_files pf where pf.job_id = ${job.jobId}::uuid and pf.kind = 'report')`;
  const rows = await db
    .update(generationJobs)
    .set({
      status: sql`case when ${delivered} then 'done' else 'failed' end`,
      error: sql`case when ${delivered} then ${generationJobs.error} else ${error} end`,
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
  await db.execute(sql`select release_credits(${job.workspaceId}::uuid, ${job.jobId}::uuid)`);
  const status = rows[0]?.status;
  return status === "done" || status === "failed" ? status : "already_final";
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

function createInlinePackRunner(): InlinePackRunner<GeneratePackInput> {
  return new InlinePackRunner<GeneratePackInput>(readInlineRunnerConfig(optionalEnv), {
    runPack: async (payload) => {
      const [{ resolveRuntimeDeps }, { runGeneratePack }] = await Promise.all([
        import("@curvi/trigger/db-runtime"),
        import("@curvi/trigger/runner"),
      ]);
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
export function getInlinePackRunner(): InlinePackRunner<GeneratePackInput> {
  return installInlinePackRunner(createInlinePackRunner, {
    handleSignals: true,
    exitAfterShutdown: Boolean(optionalEnv("NEXT_MANUAL_SIG_HANDLE")),
  });
}
