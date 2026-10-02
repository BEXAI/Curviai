/**
 * Deploy restarts (docs/phases/PHASE_18.md P18-23): a pack a deploy stops
 * starts again on the next instance instead of failing, at most once per
 * job for a pack that already ran, and never charged twice.
 *
 * At shutdown (the inline runner's drain, lib/jobs/inline-runner.ts):
 * - a pack that never started keeps its credit hold and stays queued. Its
 *   run key becomes `restart:<uuid>` and its worker payload is saved on the
 *   job (restart_payload), because the payload lives only in this process's
 *   memory. Nothing was spent, so this does not count toward the cap.
 * - a pack still running when the grace window ends, with no delivered pack
 *   files, is requeued the same way after: its run's abort signal fired
 *   first (so the old run starts no new generation attempt: withRunDeadline
 *   gates every one on it), its hold is released, the assets it saved are
 *   superseded (approved false, qc.status "superseded" and the shot id moved
 *   to qc.supersededShotId, so no charge, delivery or progress card ever
 *   matches them), its progress rows are cleared, and the seed's estimate
 *   (the payload's creditBudget) is reserved again. restart_count goes up by
 *   one; past the seed's deployRestarts.max, or when the balance no longer
 *   covers the reservation, the job is settled as before.
 * Everything runs in one transaction under the workspace row lock (the order
 * the ledger functions, settle and savePack use), conditional on the job
 * still carrying the stopped run's key and having no compliance report row,
 * so a run that finished, a cancel or a settle always wins.
 *
 * Pickup (claimRestartedJobs): a running instance takes every queued job
 * whose run key starts with `restart:`, oldest first. Each claim swaps the
 * key for a fresh one and claims runner ownership in one conditional
 * update, so exactly one instance runs each job, and the stopped run is
 * fenced by the key at its next liveness check (migration 0019). The claim
 * then runs the saved payload under the new key. The cutout comes from the
 * R2 cutout cache, so a rerun pays again only for scenes.
 *
 * scheduleRestartPickup runs a claim inside a request's after(): Render
 * starts the new instance before it stops the old one, so the drain writes
 * its restarts after the new instance booted. The health poll, the
 * stale-jobs cron and every new pack trigger a look, throttled to the
 * seed's pickupIntervalSeconds per process. after() keeps Next.js from
 * exiting on SIGTERM before those packs drain (docs/verification.md). The
 * 30 minute stale reconciler stays the backstop.
 *
 * Only first runs restart. A follow up runs on a delivered pack, so the
 * pack stays done and the follow up's hold is returned as before.
 *
 * Ships switched off: the drain's requeue step and the pickup both run only
 * while platform_settings ops:deploy_restarts_enabled is true (deployRestartsOn,
 * wired in lib/jobs/enqueue.ts). Off, a deploy settles packs as before.
 */

import { and, eq, generationJobs, notInArray, recordFunnelEvent, sql, type Db } from "@curvi/db";
import { DEPLOY_RESTARTS_SETTING, deployRestarts, type DeployRestartPolicy } from "@curvi/pipeline/seed";
import type { GeneratePackInput } from "@curvi/trigger/runner";

export const RESTART_KEY_PREFIX = "restart:";

/** How long a process reuses the deploy restarts switch it read. */
export const DEPLOY_RESTARTS_SWITCH_CACHE_MS = 30_000;

const switchScope = globalThis as typeof globalThis & {
  __curviDeployRestartsSwitch?: { on: boolean; at: number };
};

/**
 * The deploy restarts switch (platform_settings ops:deploy_restarts_enabled,
 * off by default: P18-23 ships off until its gate). Read through a per process
 * cache and fails closed: only a stored true turns restarts on, so a missing
 * row or a failed read keeps the drain settling packs as before. Off, no
 * pack is queued to start again and no restart is picked up; a restart
 * queued before it went off is failed by the stale reconciler with its hold
 * released.
 */
export async function deployRestartsOn(db: Pick<Db, "execute">, now: () => number = Date.now): Promise<boolean> {
  const cached = switchScope.__curviDeployRestartsSwitch;
  if (cached && now() - cached.at < DEPLOY_RESTARTS_SWITCH_CACHE_MS) {
    return cached.on;
  }
  let on = false;
  try {
    const rows = rowsOf<{ on: unknown }>(
      await db.execute(sql`select value = 'true'::jsonb as on from platform_settings where key = ${DEPLOY_RESTARTS_SETTING}`),
    );
    on = rows[0]?.on === true;
  } catch (err) {
    console.warn("[jobs] could not read the deploy restarts switch; treating it as off", err);
  }
  switchScope.__curviDeployRestartsSwitch = { on, at: now() };
  return on;
}

/** Forgets the cached switch (tests). */
export function resetDeployRestartsSwitchForTests(): void {
  delete switchScope.__curviDeployRestartsSwitch;
}

/** Why a pack is being restarted. */
export type RestartReason = "not_started" | "interrupted";

/** What requeueForRestart did. Anything but requeued falls back to the settle. */
export type RequeueOutcome =
  | { requeued: true; runKey: string; restartCount: number }
  | {
      requeued: false;
      why: "follow_up" | "no_run_key" | "moved" | "delivered" | "cap" | "too_old" | "insufficient_credits" | "error";
    };

/** The seller's one line notice on a restarted pack (CLAUDE.md rule 9). */
export { RESTARTED_PACK_NOTICE } from "./restart-copy";

/** The message a claimed restart whose saved payload cannot be run settles with. */
export const RESTART_PAYLOAD_INVALID_MESSAGE =
  "The server restarted while this pack was running and it could not start again. Reserved credits were released, so you can run it again.";

const TERMINAL = ["done", "failed", "canceled"] as const;

export function isRestartKey(key: string | null | undefined): boolean {
  return typeof key === "string" && key.startsWith(RESTART_KEY_PREFIX);
}

export function newRestartKey(): string {
  return `${RESTART_KEY_PREFIX}${crypto.randomUUID()}`;
}

function isFollowUpPayload(payload: unknown): boolean {
  return (payload as { kind?: unknown } | null)?.kind === "follow_up";
}

/** postgres-js returns the rows array; PGlite (tests) returns { rows }. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}

/** SQLSTATE CU402: reserve_credits found too few credits (migration 0012). */
function isInsufficientCredits(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (code === "CU402") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return /insufficient credit balance/i.test(err instanceof Error ? err.message : String(err));
}

class RequeueRefused extends Error {
  constructor(readonly why: Exclude<RequeueOutcome, { requeued: true }>["why"]) {
    super(why);
  }
}

/** The payload as the job saves it: everything but the run key, which the
 * claim sets fresh. */
function storedPayload(payload: GeneratePackInput): Record<string, unknown> {
  const { runKey: _runKey, ...rest } = payload;
  void _runKey;
  return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
}

export interface RequeueOptions {
  /** Operator-only recovery; never permits done or canceled jobs. */
  allowFailed?: boolean;
  onlyIf?: Parameters<typeof and>[number];
  policy?: DeployRestartPolicy;
  now?: Date;
  log?: Pick<Console, "warn" | "error">;
}

/**
 * Queues a pack this instance is shutting down on to start again (see the
 * module comment). Never throws: every refusal comes back as an outcome
 * and the caller settles the job as before.
 */
export async function requeueForRestart(
  db: Db,
  payload: GeneratePackInput | { kind: "follow_up" },
  reason: RestartReason,
  opts: RequeueOptions = {},
): Promise<RequeueOutcome> {
  if (isFollowUpPayload(payload)) {
    return { requeued: false, why: "follow_up" };
  }
  const input = payload as GeneratePackInput;
  if (!input.runKey) {
    return { requeued: false, why: "no_run_key" };
  }
  const policy = opts.policy ?? deployRestarts;
  const now = opts.now ?? new Date();
  const log = opts.log ?? console;
  const runKey = newRestartKey();
  try {
    const restartCount = await db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from workspaces where id = ${input.workspaceId}::uuid for update`);
      const rows = rowsOf<{ status: string; run_key: string | null; restart_count: number | string; created_at: Date | string; delivered: boolean }>(
        await tx.execute(sql`
          select status, run_key, restart_count, created_at,
            exists (select 1 from pack_files pf where pf.job_id = generation_jobs.id and pf.kind = 'report') as delivered
          from generation_jobs
          where id = ${input.jobId}::uuid and workspace_id = ${input.workspaceId}::uuid and (${opts.onlyIf ?? sql`true`})
          for update`),
      );
      const job = rows[0];
      if (!job || ((TERMINAL as readonly string[]).includes(job.status) && !(opts.allowFailed && job.status === "failed")) || job.run_key !== input.runKey) {
        throw new RequeueRefused("moved");
      }
      if (now.getTime() - new Date(job.created_at).getTime() > policy.windowMinutes * 60_000) {
        throw new RequeueRefused("too_old");
      }
      if (job.delivered) {
        throw new RequeueRefused("delivered");
      }
      let count = Number(job.restart_count);
      if (reason === "not_started") {
        if (job.status !== "queued") {
          throw new RequeueRefused("moved");
        }
      } else {
        if (count >= policy.max) {
          throw new RequeueRefused("cap");
        }
        await tx.execute(sql`select release_credits(${input.workspaceId}::uuid, ${input.jobId}::uuid)`);
        // Superseded: never charged (deliveredCharges needs approved), never
        // delivered and never a progress card (each matches on qc.shotId).
        const patch = JSON.stringify({ status: "superseded", pass: false, supersededAt: now.toISOString() });
        await tx.execute(sql`
          update assets
          set approved = false,
              qc = (coalesce(qc, '{}'::jsonb) - 'shotId')
                || ${patch}::jsonb
                || jsonb_build_object('supersededShotId', qc->>'shotId')
          where job_id = ${input.jobId}::uuid and workspace_id = ${input.workspaceId}::uuid and qc ? 'shotId'`);
        // Display only: the rerun writes its own plan rows.
        await tx.execute(sql`delete from job_steps where job_id = ${input.jobId}::uuid`);
        // reserve_credits adds to credits_reserved, so the hold shown on the
        // pack page stays the one estimate rather than doubling.
        await tx.execute(sql`update generation_jobs set credits_reserved = 0 where id = ${input.jobId}::uuid`);
        try {
          await tx.transaction(async (sp) => {
            await sp.execute(
              sql`select reserve_credits(${input.workspaceId}::uuid, ${input.creditBudget}::numeric, ${input.jobId}::uuid)`,
            );
          });
        } catch (err) {
          throw isInsufficientCredits(err) ? new RequeueRefused("insufficient_credits") : err;
        }
        count += 1;
      }
      const moved = await tx
        .update(generationJobs)
        .set({
          status: "queued",
          runKey,
          restartCount: count,
          restartPayload: storedPayload(input),
          runnerId: null,
          heartbeatAt: null,
          startedAt: null,
          finishedAt: null,
          error: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(generationJobs.id, input.jobId),
            eq(generationJobs.workspaceId, input.workspaceId),
            eq(generationJobs.runKey, input.runKey!),
            notInArray(generationJobs.status, opts.allowFailed ? ["done", "canceled"] : [...TERMINAL]),
            opts.onlyIf,
          ),
        )
        .returning({ id: generationJobs.id });
      if (moved.length === 0) {
        throw new RequeueRefused("moved");
      }
      return count;
    });
    await recordFunnelEvent(db, {
      workspaceId: input.workspaceId,
      name: "pack_restarted",
      props: { reason, restart_count: restartCount },
      at: now,
    });
    log.warn(JSON.stringify({ level: "warn", event: "pack_restart_queued", jobId: input.jobId, reason, restartCount }));
    return { requeued: true, runKey, restartCount };
  } catch (err) {
    if (err instanceof RequeueRefused) {
      return { requeued: false, why: err.why };
    }
    log.error(`[jobs] could not queue job ${input.jobId} to start again after ${reason}`, err);
    return { requeued: false, why: "error" };
  }
}

/** A saved payload the claim may run: an object for this job whose photos
 * all live in this workspace. Null otherwise. The trigger in migration
 * deploy_restarts keeps clients from writing it; this is a second check. */
export function restoredPayload(
  row: { id: string; workspace_id: string; restart_payload: unknown },
  runKey: string,
): GeneratePackInput | null {
  const saved = row.restart_payload;
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return null;
  const payload = saved as Partial<GeneratePackInput>;
  const prefix = `ws/${row.workspace_id}/`;
  const images = Array.isArray(payload.images) ? payload.images : null;
  if (
    !images ||
    !images.every((image) => typeof image?.mediaId === "string" && image.mediaId.startsWith(prefix) && !image.mediaId.includes("..")) ||
    !Array.isArray(payload.channels) ||
    typeof payload.tier !== "string" ||
    typeof payload.creditBudget !== "number" ||
    !(payload.creditBudget > 0)
  ) {
    return null;
  }
  return { ...(payload as GeneratePackInput), jobId: row.id, workspaceId: row.workspace_id, runKey };
}

export interface ClaimOptions {
  runnerId?: string;
  jobId?: string;
  limit?: number;
  log?: Pick<Console, "warn" | "error">;
  /** Settles a claimed job whose payload cannot run; settleInterruptedJob by default. */
  settle?: (job: { jobId: string; workspaceId: string }, message: string) => Promise<unknown>;
}

/**
 * Claims the queued restarts, oldest first, and returns the payloads this
 * caller now owns. Each claim is one conditional update (the restart key
 * swapped for a fresh one, the saved payload retained for recovery), so two instances
 * looking at once never claim the same job.
 */
export async function claimRestartedJobs(db: Db, opts: ClaimOptions = {}): Promise<GeneratePackInput[]> {
  const limit = opts.limit ?? deployRestarts.pickupBatch;
  const log = opts.log ?? console;
  const rows = rowsOf<{ id: string; workspace_id: string; run_key: string; restart_payload: unknown }>(
    await db.execute(sql`
      select id, workspace_id, run_key, restart_payload
      from generation_jobs
      where status = 'queued' and runner_id is null and run_key like ${`${RESTART_KEY_PREFIX}%`}
        and (${opts.jobId ? sql`id = ${opts.jobId}::uuid` : sql`true`})
      order by created_at asc
      limit ${limit}`),
  );
  const claimed: GeneratePackInput[] = [];
  for (const row of rows) {
    const runKey = crypto.randomUUID();
    const won = await db
      .update(generationJobs)
      .set({ runKey, runnerId: opts.runnerId ?? null, heartbeatAt: new Date(), updatedAt: new Date() })
      .where(and(eq(generationJobs.id, row.id), eq(generationJobs.runKey, row.run_key), eq(generationJobs.status, "queued"), sql`${generationJobs.runnerId} is null`))
      .returning({ id: generationJobs.id });
    if (won.length === 0) {
      continue;
    }
    const payload = restoredPayload(row, runKey);
    if (!payload) {
      log.error(`[jobs] restarted job ${row.id} has no payload that can run; settling it`);
      const settle =
        opts.settle ??
        (async (job: { jobId: string; workspaceId: string }, message: string) => {
          const { settleInterruptedJob } = await import("./settle");
          return settleInterruptedJob(db, job, message);
        });
      try {
        await settle({ jobId: row.id, workspaceId: row.workspace_id }, RESTART_PAYLOAD_INVALID_MESSAGE);
      } catch (err) {
        log.error(`[jobs] could not settle restarted job ${row.id}`, err);
      }
      continue;
    }
    claimed.push(payload);
  }
  if (claimed.length > 0) {
    log.warn(JSON.stringify({ level: "warn", event: "pack_restarts_claimed", count: claimed.length }));
  }
  return claimed;
}
