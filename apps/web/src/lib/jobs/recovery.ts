import { and, eq, generationJobs, notInArray, sql, type Db } from "@curvi/db";
import { deployRestarts, orphan } from "@curvi/pipeline/seed";
import { Shot } from "@curvi/pipeline/schemas";
import type { GeneratePackInput } from "@curvi/trigger/runner";
import type { PackFollowUpInput } from "@curvi/trigger/follow-up";
import { runnerId } from "./runner-owner";
import { restoredPayload } from "./restart";
import { settleJob } from "./settle";

const TERMINAL = ["done", "failed", "canceled"] as const;
const CRASH_MESSAGE = "This pack stopped before it could finish. Reserved credits were released, so you can try again.";
type RecoveryPayload = GeneratePackInput | PackFollowUpInput;
type Candidate = { id: string; workspace_id: string; run_key: string | null; status: string; started_at: Date | null; created_at: Date; restart_payload: unknown };
function rowsOf<T>(result: unknown): T[] { return (Array.isArray(result) ? result : (result as { rows?: T[] }).rows ?? []) as T[]; }

function waitingPayload(row: Candidate, key: string, now: Date): RecoveryPayload | null {
  if (row.started_at !== null) return null;
  const value = row.restart_payload;
  const stored = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!stored) return null;
  const followUp = stored.kind === "follow_up";
  const accepted = followUp ? Date.parse(String(stored.acceptedAt ?? "")) : new Date(row.created_at).getTime();
  if (!Number.isFinite(accepted) || now.getTime() - accepted > deployRestarts.windowMinutes * 60_000 || accepted > now.getTime() + 5_000) return null;
  if (!followUp) return row.status === "queued" ? restoredPayload(row, key) : null;
  if (row.status !== "generating" || !["retry", "add_angle", "regenerate"].includes(String(stored.reason)) ||
      typeof stored.creditBudget !== "number" || stored.creditBudget <= 0 || !Number.isFinite(stored.creditBudget) ||
      typeof stored.baseCostMicros !== "number" || stored.baseCostMicros < 0 || !Number.isFinite(stored.baseCostMicros) ||
      !Array.isArray(stored.channels) || !stored.channels.every((channel) => typeof channel === "string") ||
      !stored.existingFilesBySpec || typeof stored.existingFilesBySpec !== "object" || Array.isArray(stored.existingFilesBySpec) ||
      !Array.isArray(stored.shots) || stored.shots.length === 0 || stored.shots.length > 40) return null;
  const shots = stored.shots.map((shot) => Shot.safeParse(shot));
  const prefix = `ws/${row.workspace_id}/`;
  if (shots.some((shot) => !shot.success || !shot.data.sourceMediaId.startsWith(prefix) || shot.data.sourceMediaId.includes(".."))) return null;
  return { ...stored, jobId: row.id, workspaceId: row.workspace_id, runKey: key } as unknown as PackFollowUpInput;
}

/** Recover only jobs whose owner stopped heartbeating. A queued original
 * or prepared followup has spent nothing and keeps its hold; a running
 * crash is never retried. Payload preparation failures safely release. */
export async function recoverOrphanJobs(db: Db, opts: {
  now?: Date; owner?: string; submit?: (payload: RecoveryPayload) => void | Promise<void>;
} = {}): Promise<{ claimed: number; settled: number; failures: number }> {
  const now = opts.now ?? new Date();
  const owner = opts.owner ?? runnerId();
  const cutoff = new Date(now.getTime() - orphan.staleHeartbeatMinutes * 60_000);
  const stale = sql`coalesce(${generationJobs.heartbeatAt}, ${generationJobs.updatedAt}) < ${cutoff}`;
  const otherOwner = sql`(${generationJobs.runnerId} is null or ${generationJobs.runnerId} <> ${owner})`;
  const candidates = rowsOf<Candidate>(await db.execute(sql`
    select id, workspace_id, run_key, status, started_at, created_at, restart_payload from generation_jobs
    where status not in ('done', 'failed', 'canceled')
      and coalesce(heartbeat_at, updated_at) < ${cutoff}
      and (runner_id is null or runner_id <> ${owner})
    order by created_at, id limit 200`));
  const result = { claimed: 0, settled: 0, failures: 0 };
  for (const row of candidates) {
    const oldRun = row.run_key === null ? sql`${generationJobs.runKey} is null` : eq(generationJobs.runKey, row.run_key);
    const fence = and(stale, otherOwner, oldRun);
    try {
      const key = crypto.randomUUID();
      const payload = waitingPayload(row, key, now);
      if (payload) {
        const won = await db.update(generationJobs).set({ runKey: key, runnerId: owner, heartbeatAt: now, updatedAt: now })
          .where(and(eq(generationJobs.id, row.id), sql`${generationJobs.status} = ${row.status}`, sql`${generationJobs.startedAt} is null`, fence))
          .returning({ id: generationJobs.id });
        if (!won.length) continue;
        const submit = opts.submit ?? (async (input: RecoveryPayload) => {
          const { getInlinePackRunner } = await import("./enqueue");
          // The process runner owns this promise; the recovery sweep need not
          // wait for an entire pack before checking the next orphan.
          void getInlinePackRunner().submit(input);
        });
        try {
          await submit(payload);
          result.claimed += 1;
        } catch (err) {
          await settleJob(db, { jobId: row.id, workspaceId: row.workspace_id }, {
            undelivered: "failed", error: CRASH_MESSAGE, now,
            onlyIf: and(eq(generationJobs.runKey, key), eq(generationJobs.runnerId, owner)),
          });
          throw err;
        }
      } else {
        const settled = await settleJob(db, { jobId: row.id, workspaceId: row.workspace_id }, {
          undelivered: "failed", error: CRASH_MESSAGE, now, onlyIf: and(fence, notInArray(generationJobs.status, [...TERMINAL])),
        });
        if (settled.status) result.settled += 1;
      }
    } catch (err) {
      result.failures += 1;
      console.error(`[jobs] could not recover orphan ${row.id}`, err);
    }
  }
  return result;
}

const scope = globalThis as typeof globalThis & { __curviRecovery?: { timer: ReturnType<typeof setTimeout>; busy: boolean } };
/** Node instrumentation calls once. No requests or live providers run in
 * demo mode; the first DB sweep starts after the process has booted. */
export function startJobRecovery(): void {
  if (scope.__curviRecovery || !process.env.DATABASE_URL) return;
  const state = { timer: undefined as unknown as ReturnType<typeof setTimeout>, busy: false };
  const sweep = async () => {
    if (state.busy) return;
    state.busy = true;
    try {
      const { getDb } = await import("@/lib/services/db");
      await recoverOrphanJobs(getDb());
    } catch (err) { console.error("[jobs] orphan recovery failed", err); }
    finally {
      state.busy = false;
      state.timer = setTimeout(sweep, orphan.sweepEverySeconds * 1000);
      state.timer.unref?.();
    }
  };
  state.timer = setTimeout(sweep, 15_000);
  state.timer.unref?.();
  scope.__curviRecovery = state;
}
