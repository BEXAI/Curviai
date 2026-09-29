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
import { and, eq, generationJobs, notInArray, sql, type Db } from "@curvi/db";
import { settleInterruptedJob } from "./settle";
import { optionalEnv } from "@/lib/env";
import {
  DEFAULT_MAX_RUN_MS,
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

export {
  deliveredCharges,
  settleInterruptedJob,
  settleJob,
  type DeliveredCharge,
  type SettleOutcome,
  type SettleResult,
} from "./settle";

/** Bumps updated_at on jobs waiting for an inline slot, so they never look
 * stale to the reconciler. A job still queued is bumped by id. A follow up
 * waits with its job already back in generating (startFollowUp), so it is
 * bumped when the job's run_key is still the waiting entry's key: once that
 * run starts, settles or is replaced, the key no longer matches and the
 * heartbeat leaves the job alone. Finished jobs are never touched. */
export async function heartbeatQueuedJobs(db: Db, jobIds: string[], runKeys: string[] = []): Promise<void> {
  if (jobIds.length === 0) {
    return;
  }
  const idArray = `{${jobIds.join(",")}}`;
  const byId = sql`${generationJobs.id} = any(${idArray}::uuid[])`;
  const queued = eq(generationJobs.status, "queued");
  const waiting =
    runKeys.length > 0
      ? sql`(${queued} or (${generationJobs.runKey} = any(${`{${runKeys.join(",")}}`}::text[]) and ${notInArray(generationJobs.status, ["done", "failed", "canceled"])}))`
      : queued;
  await db.update(generationJobs).set({ updatedAt: new Date() }).where(and(byId, waiting));
}

async function appDb(): Promise<Db> {
  const { getDb } = await import("@/lib/services/db");
  return getDb();
}

/** Time the runner keeps after it stops starting shots, for packaging,
 * storing and charging what passed before the run cap settles the job. */
export const PACKAGING_RESERVE_MS = 4 * 60_000;

/** When a run started now must stop starting new shots: the run cap less
 * the packaging reserve, and never less than half the cap. */
export function stopStartingAt(startedAt: number, maxRunMs: number): number {
  return startedAt + Math.max(maxRunMs - PACKAGING_RESERVE_MS, Math.floor(maxRunMs / 2));
}

function createInlinePackRunner(): InlinePackRunner<InlineRunPayload> {
  const config = readInlineRunnerConfig(optionalEnv);
  return new InlinePackRunner<InlineRunPayload>(config, {
    runPack: async (payload, signal) => {
      const { resolveRuntimeDeps: runtimeDeps } = await import("@curvi/trigger/db-runtime");
      // The run cap settles a job with no report row as failed and throws
      // away every shot that passed, so the runner stops starting shots
      // early enough to package and charge what it has (runDeadline).
      const runDeadline = { stopStartingAt: stopStartingAt(Date.now(), config.maxRunMs ?? DEFAULT_MAX_RUN_MS), signal };
      const resolveRuntimeDeps = () => ({ ...runtimeDeps(), runDeadline });
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
    heartbeat: async (jobIds, runKeys) => heartbeatQueuedJobs(await appDb(), jobIds, runKeys),
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
