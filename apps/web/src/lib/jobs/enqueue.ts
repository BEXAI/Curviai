/**
 * The bridge from POST /api/jobs to the inline pack runner. Packs run in
 * this process after the response flushes, using the database backed store.
 * The retired Trigger.dev setting cannot change where a pack runs.
 *
 * Inline packs go through the process wide InlinePackRunner: a concurrency
 * limit (CURVI_INLINE_PACK_CONCURRENCY) with waiting jobs queued in order, a
 * wall clock cap per run (CURVI_INLINE_PACK_MAX_RUN_MS, 25 minutes by
 * default) so one hung pack cannot hold the queue, and a SIGTERM drain that
 * settles every job it cannot finish, so a deploy never leaves a job stuck
 * with its credits held. A first run the drain stops is queued to start
 * again instead (lib/jobs/restart.ts, docs/phases/PHASE_18.md P18-23), and
 * scheduleRestartPickup lets a running instance claim and run it.
 */

import { after } from "next/server";
import type { PackFollowUpInput } from "@curvi/trigger/follow-up";
import type { GeneratePackInput } from "@curvi/trigger/runner";
import { and, eq, generationJobs, notInArray, sql, type Db } from "@curvi/db";
import { deployRestarts, orphan } from "@curvi/pipeline/seed";
import { runnerId } from "./runner-owner";
import { memoryAllowsStart } from "./memory";
import { readMemoryLimit } from "@/lib/config-health";
import { getPackMaintenance } from "@/lib/pack-maintenance";
import { settleInterruptedJob } from "./settle";
import { optionalEnv } from "@/lib/env";
import { reportSettleFailure, reportSettledJob, withJobScope } from "@/lib/sentry/jobs";
import {
  DEFAULT_MAX_RUN_MS,
  InlinePackRunner,
  currentInlinePackRunner,
  installInlinePackRunner,
  readInlineRunnerConfig,
  type InlineRunnerConfig,
  type SettleReason,
} from "./inline-runner";
import { claimRestartedJobs, deployRestartsOn, requeueForRestart } from "./restart";

export type EnqueueMode = "inline";

/** What the inline runner queues: a first pack run or a pack follow up (a
 * retried shot or an added angle on a delivered pack). */
export type InlineRunPayload = GeneratePackInput | PackFollowUpInput;

function isFollowUp(payload: InlineRunPayload): payload is PackFollowUpInput {
  return (payload as { kind?: unknown }).kind === "follow_up";
}

export async function enqueueGeneratePack(payload: GeneratePackInput): Promise<EnqueueMode> {

  const runner = getInlinePackRunner();
  // A draining instance takes no new work. The throw sends the caller down
  // its existing failure path, which marks the job failed and releases the
  // hold before the response goes out.
  runner.assertAccepting();
  // submit never rejects and resolves once the job is finished or settled;
  // after() keeps Next.js from exiting on SIGTERM until that happens.
  after(() => runner.submit(payload));
  // A deploy may have left packs to start again (P18-23); throttled.
  scheduleRestartPickup();
  return "inline";
}

/**
 * Queues a pack follow up inline, exactly like a first run. The caller already holds the credits
 * and moved the job back to generating; a throw here is the caller's cue to
 * return the hold.
 */
export async function enqueuePackFollowUp(payload: PackFollowUpInput): Promise<EnqueueMode> {
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
 * stale to the reconciler. A queued job with a persisted run key is fenced by that key. A follow up
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
      ? sql`(${generationJobs.runKey} = any(${`{${runKeys.join(",")}}`}::text[]) and ${notInArray(generationJobs.status, ["done", "failed", "canceled"])})`
      : queued;
  await db.update(generationJobs).set({ updatedAt: new Date(), heartbeatAt: new Date(), runnerId: runnerId() }).where(and(byId, waiting, sql`(${generationJobs.runnerId} is null or ${generationJobs.runnerId} = ${runnerId()})`));
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

/**
 * Settles a job the runner gave up on, inside the job's error reporting
 * scope (docs/phases/PHASE_20.md P20-13): a shutdown's interrupted and not
 * started jobs are reported as warnings (a crash and a run past its time
 * cap are reported as errors by the runner's own log lines, which run in
 * the job's context), and a settle that fails is reported with its
 * exception before the runner logs it.
 */
async function settleAndReport(payload: InlineRunPayload, reason: SettleReason): Promise<void> {
  reportSettledJob(payload, reason);
  try {
    const outcome = await settleInterruptedJob(await appDb(), payload, SETTLED_JOB_MESSAGES[reason]);
    console.warn(`[jobs] settled job ${payload.jobId} after ${reason}: ${outcome}`);
  } catch (err) {
    reportSettleFailure(payload, reason, err);
    throw err;
  }
}

/** The process's runner as getInlinePackRunner installs it. `config`
 * overrides the env settings (tests). */
export function createInlinePackRunner(
  config: InlineRunnerConfig = readInlineRunnerConfig(optionalEnv),
): InlinePackRunner<InlineRunPayload> {
  return new InlinePackRunner<InlineRunPayload>({ ...config, heartbeatMs: orphan.heartbeatSeconds * 1000 }, {
    canStart: async (running) => {
      if (!memoryAllowsStart(running, process.memoryUsage.rss(), readMemoryLimit())) return false;
      return !(await getPackMaintenance(await appDb())).deployPending;
    },
    heartbeatRunning: async (jobs) => {
      const db = await appDb();
      for (const job of jobs) {
        await db.update(generationJobs).set({ heartbeatAt: new Date() }).where(and(
          eq(generationJobs.id, job.jobId), eq(generationJobs.runnerId, runnerId()),
          job.runKey ? eq(generationJobs.runKey, job.runKey) : undefined,
          notInArray(generationJobs.status, ["done", "failed", "canceled"]),
        ));
      }
    },
    // Every event a pack run reports (a crash, its time cap, a console.error
    // in the pipeline) carries job_id, workspace_id, run_key and run_kind.
    inJobContext: withJobScope,
    runPack: async (payload, signal) => {
      const db = await appDb();
      const started = await db.update(generationJobs).set({
        runnerId: runnerId(), heartbeatAt: new Date(), startedAt: new Date(), finishedAt: null,
      }).where(and(eq(generationJobs.id, payload.jobId),
        payload.runKey ? eq(generationJobs.runKey, payload.runKey) : undefined,
        notInArray(generationJobs.status, ["done", "failed", "canceled"]),
        sql`(${generationJobs.runnerId} is null or ${generationJobs.runnerId} = ${runnerId()})`,
      )).returning({ id: generationJobs.id });
      if (started.length === 0) return;
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
      await withJobScope(payload, () => settleAndReport(payload, reason));
    },
    // P18-23: a first run a deploy stops is queued to start again on the
    // next instance instead of failing; anything refused is settled above.
    // Only while the ops:deploy_restarts_enabled switch is on (off by default).
    requeue: async (payload, reason) => {
      if (isFollowUp(payload)) {
        return false;
      }
      const db = await appDb();
      if (!(await deployRestartsOn(db))) {
        return false;
      }
      const outcome = await requeueForRestart(db, payload, reason);
      if (!outcome.requeued) {
        console.warn(`[jobs] job ${payload.jobId} was not queued to start again after ${reason} (${outcome.why})`);
      }
      return outcome.requeued;
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

const pickupScope = globalThis as typeof globalThis & { __curviRestartPickupAt?: number };

/**
 * Claims the packs a deploy queued to start again and runs them here
 * (docs/phases/PHASE_18.md P18-23, lib/jobs/restart.ts). Called by the
 * health poll, the stale-jobs cron and every new pack, at most once per the
 * seed's pickupIntervalSeconds per process unless forced. The claim and the
 * runs happen inside the request's after(), so Next.js waits for those packs
 * on SIGTERM just as it waits for a new pack; outside a request there is no
 * after() and nothing happens. Only for inline packs with a database,
 * never on an instance that is draining, and only while the
 * ops:deploy_restarts_enabled switch is on. Returns true when a look was
 * scheduled.
 */
export function scheduleRestartPickup(opts: { force?: boolean; now?: number } = {}): boolean {
  if (!optionalEnv("DATABASE_URL")) {
    return false;
  }
  const existing = currentInlinePackRunner();
  if (existing && !existing.accepting) {
    return false;
  }
  const now = opts.now ?? Date.now();
  const last = pickupScope.__curviRestartPickupAt;
  if (!opts.force && last !== undefined && now - last < deployRestarts.pickupIntervalSeconds * 1000) {
    return false;
  }
  pickupScope.__curviRestartPickupAt = now;
  try {
    after(async () => {
      try {
        // Off (the seeded default), nothing else happens: no runner, no claim.
        const db = await appDb();
        if (!(await deployRestartsOn(db))) {
          return;
        }
        const runner = getInlinePackRunner();
        if (!runner.accepting) {
          return;
        }
        const payloads = await claimRestartedJobs(db, { runnerId: runnerId() });
        await Promise.all(payloads.map((payload) => runner.submit(payload)));
      } catch (err) {
        console.error("[jobs] the restart pickup failed", err);
      }
    });
    return true;
  } catch {
    // No request scope: the next health poll or cron call looks instead.
    pickupScope.__curviRestartPickupAt = last;
    return false;
  }
}

/** Forgets when this process last looked for restarts (tests). */
export function resetRestartPickupForTests(): void {
  delete pickupScope.__curviRestartPickupAt;
}
