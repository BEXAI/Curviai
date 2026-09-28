/**
 * Pack follow ups: work a seller asks for on a pack that was already
 * delivered. Two kinds exist today:
 *
 * - retry: one shot that ended in needs review runs again exactly as it was
 *   planned (the planned shot is stored on its asset row).
 * - add_angle: the seller uploads a photo of an angle the planner skipped
 *   ("needs photo"), and the shots that needed it are planned and run.
 *
 * The web app holds the credits for the follow up shots against the same job
 * (reserve_credits adds to the job's hold), moves the job from done back to
 * generating so every liveness check works as it does for a first run, and
 * then queues this runner. The ledger rules are the pack's: a shot that
 * needs review is released, a passing shot is charged under its shot id only
 * once its file is delivered, and anything left of the hold is released.
 *
 * The pack itself was delivered by its first run, so a follow up never fails
 * the job: however it ends (done, stopped by a cancel, an error), the job goes
 * back to done and whatever the follow up still holds goes back to the
 * seller's balance. Product pixels stay untouched: the shots run through
 * runShot with the same generators and fidelity checks as a first run
 * (CLAUDE.md rule 3).
 */

import { buildPack, type Shot } from "@curvi/pipeline";
import { channelFileLimit, getSpec, hasSpec } from "@curvi/specs";
import {
  JobAbandonedError,
  recordShotFailure,
  runShot,
  selectedFamilies,
  SHOT_CHANNEL_FULL,
  SHOT_NOT_DELIVERED,
  type PipelineDeps,
  type ShotContext,
  type ShotOutcome,
  type ShotPackAsset,
  type StoredFollowUpFiles,
} from "./pipeline-runner";
import { JobLedgerPlan, type LedgerAction } from "./state";

export type PackFollowUpReason = "retry" | "add_angle";

export interface PackFollowUpInput {
  /** Tells a follow up payload apart from a GeneratePackInput on a shared queue. */
  kind: "follow_up";
  /** Unique per follow up: its queue key and the prefix of its stored files. */
  runKey: string;
  jobId: string;
  workspaceId: string;
  reason: PackFollowUpReason;
  /** The shots to run, each with its credits from the seed price table. */
  shots: Shot[];
  /** Credits the web app held for these shots: the sum of their credits. */
  creditBudget: number;
  /** The pack's selected channels; decides which channel families get files. */
  channels: string[];
  mode?: "listing" | "concept";
  sku?: string;
  seoSlug?: string;
  brandColors?: string[];
  /** Files each channel spec already holds in the delivered pack, so new
   * files are numbered after them and no spec passes its image limit. */
  existingFilesBySpec: Record<string, number>;
  /** The job's provider spend before this follow up, in USD micros. The
   * job's COGS only ever grows, so the follow up reports the sum. */
  baseCostMicros: number;
}

export interface PackFollowUpSummary {
  jobId: string;
  runKey: string;
  /** done: the follow up ran to its end. stopped: a cancel, a settle or an
   * error ended it early; its remaining hold was returned. */
  state: "done" | "stopped";
  reservedCredits: number;
  chargedCredits: number;
  releasedCredits: number;
  passed: number;
  needsReview: number;
  costMicros: number;
  error?: string;
}

export function isPackFollowUpInput(payload: unknown): payload is PackFollowUpInput {
  return (
    typeof payload === "object" && payload !== null && (payload as { kind?: unknown }).kind === "follow_up"
  );
}

/**
 * Numbers the passing files of a follow up after the files each spec already
 * holds, and leaves out any file past its spec's image limit. Pure, so the
 * limits are unit tested. Returns the files to package and the shots none
 * of whose files fit.
 */
export function numberFollowUpFiles(
  passing: readonly ShotOutcome[],
  existingFilesBySpec: Readonly<Record<string, number>>,
): { assets: ShotPackAsset[]; full: Set<string> } {
  const used = new Map<string, number>();
  const assets: ShotPackAsset[] = [];
  const full = new Set<string>();
  for (const outcome of passing) {
    let kept = 0;
    for (const asset of outcome.packAssets ?? []) {
      if (!hasSpec(asset.specId)) {
        continue;
      }
      const count = used.get(asset.specId) ?? Math.max(0, existingFilesBySpec[asset.specId] ?? 0);
      const limit = channelFileLimit(getSpec(asset.specId));
      if (limit !== null && count >= limit) {
        continue;
      }
      used.set(asset.specId, count + 1);
      assets.push({ ...asset, n: count + 1 });
      kept += 1;
    }
    if (kept === 0) {
      full.add(outcome.shotId);
    }
  }
  return { assets, full };
}

export async function runPackFollowUp(
  input: PackFollowUpInput,
  deps: PipelineDeps,
): Promise<PackFollowUpSummary> {
  const { store, clock } = deps;
  const ledger = new JobLedgerPlan();
  let costMicros = 0;
  let passed = 0;
  let needsReview = 0;
  let settled = false;

  const applyLedger = async (action: LedgerAction | null): Promise<void> => {
    if (!action) {
      return;
    }
    await store.appendLedger({ ...action, jobId: input.jobId, workspaceId: input.workspaceId, at: clock.now() });
  };
  // The heartbeat returns false once the job is terminal: a cancel or a
  // settle ended the follow up, so nothing more is spent or delivered.
  const assertLive = async (): Promise<void> => {
    if ((await store.heartbeat?.(input.jobId)) === false) {
      throw new JobAbandonedError(input.jobId);
    }
  };
  // Back to done: the pack was delivered by its first run. A job a cancel or
  // a settle already finished is left as it is (setJobState refuses).
  const backToDone = async (): Promise<void> => {
    await store.setJobState(input.jobId, "done", { costMicros: input.baseCostMicros + costMicros });
  };
  const summarize = (state: PackFollowUpSummary["state"], error?: string): PackFollowUpSummary => ({
    jobId: input.jobId,
    runKey: input.runKey,
    state,
    reservedCredits: ledger.reserved,
    chargedCredits: ledger.charged,
    releasedCredits: ledger.released,
    passed,
    needsReview,
    costMicros,
    ...(error !== undefined ? { error } : {}),
  });

  // The web app already holds these credits; stores that reserve for
  // themselves (tests, demo) reserve here, and the plan tracks the hold.
  await applyLedger(ledger.reserveOnQueue(input.creditBudget));

  try {
    await assertLive();
    const ctx: ShotContext = {
      jobId: input.jobId,
      workspaceId: input.workspaceId,
      sku: input.sku,
      seoSlug: input.seoSlug,
      mode: input.mode ?? "listing",
      brandColors: input.brandColors,
    };
    // One shot failing never takes its siblings down, as in a first run.
    const runShots =
      deps.runShots ??
      (async (shots: Shot[], c: ShotContext): Promise<ShotOutcome[]> => {
        const results = await Promise.allSettled(shots.map((s) => runShot(s, c, deps)));
        return Promise.all(
          results.map((result, i) =>
            result.status === "fulfilled" ? result.value : recordShotFailure(store, shots[i], c, result.reason),
          ),
        );
      });
    const outcomes = await runShots(input.shots, ctx);
    costMicros += outcomes.reduce((sum, o) => sum + o.costMicros, 0);

    for (const outcome of outcomes) {
      if (outcome.status !== "passed") {
        needsReview += 1;
        if (outcome.credits > 0) {
          await applyLedger(ledger.releaseForFailedShot(outcome.shotId, outcome.credits));
        }
      }
    }

    const passing = outcomes.filter((o) => o.status === "passed");
    if (passing.length > 0) {
      await assertLive();
      const { assets, full } = numberFollowUpFiles(passing, input.existingFilesBySpec);
      const families = [...selectedFamilies(input.channels)];
      const built = assets.length > 0 ? await buildPack(assets, families, { outDir: deps.packOutDir, writeFiles: true }) : null;
      const files: StoredFollowUpFiles["files"] = (built?.report.files ?? [])
        .filter((f): f is typeof f & { ref: string } => f.ref !== null)
        .map((f) => ({
          channel: f.channel,
          file: f.file,
          specId: f.specId,
          ref: f.ref,
          width: f.measured?.width ?? null,
          height: f.measured?.height ?? null,
        }));
      let recorded = new Set<string>();
      if (built && files.length > 0) {
        if (!store.saveFollowUpFiles) {
          throw new Error("This store cannot deliver follow up files.");
        }
        await assertLive();
        recorded = new Set(
          await store.saveFollowUpFiles({
            jobId: input.jobId,
            workspaceId: input.workspaceId,
            runKey: input.runKey,
            outDir: built.outDir,
            files,
          }),
        );
      }
      await store.heartbeat?.(input.jobId);
      // Charge each shot once, and only when its file is in the pack.
      for (const outcome of passing) {
        if (recorded.has(outcome.shotId)) {
          passed += 1;
          if (outcome.credits > 0) {
            await applyLedger(ledger.chargeForPassingAsset(outcome.shotId, outcome.credits));
          }
          continue;
        }
        needsReview += 1;
        const reason = full.has(outcome.shotId) ? SHOT_CHANNEL_FULL : SHOT_NOT_DELIVERED;
        if (outcome.credits > 0) {
          await applyLedger(ledger.releaseForUndeliveredShot(outcome.shotId, outcome.credits, reason));
        }
        try {
          await store.markShotUndelivered?.({
            jobId: input.jobId,
            workspaceId: input.workspaceId,
            shotId: outcome.shotId,
            shotType: outcome.shotType,
            reason,
          });
        } catch (markErr) {
          console.warn(`[follow-up] could not mark shot ${outcome.shotId} as not delivered`, markErr);
        }
      }
    }

    await applyLedger(ledger.releaseUnusedOnCompletion());
    settled = true;
    await backToDone();
    return summarize("done");
  } catch (err) {
    if (settled) {
      console.error(`[follow-up] job ${input.jobId} settled its follow up but could not be marked done`, err);
      return summarize("done");
    }
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof JobAbandonedError)) {
      console.error(`[follow-up] follow up ${input.runKey} of job ${input.jobId} stopped`, err);
    }
    try {
      await backToDone();
    } catch (stateErr) {
      console.error(`[follow-up] could not mark job ${input.jobId} done again`, stateErr);
    }
    try {
      // A job settled elsewhere already had this hold released there.
      if (!(err instanceof JobAbandonedError)) {
        await applyLedger(ledger.releaseRemainderOnFailure("failed"));
      }
    } catch (releaseErr) {
      console.error(`[follow-up] planned release failed for job ${input.jobId}`, releaseErr);
    }
    try {
      // The first run settled its own hold, so everything still held for
      // the job belongs to this follow up.
      await store.releaseAllHeld?.(input.jobId, input.workspaceId);
    } catch (sweepErr) {
      console.error(`[follow-up] release sweep failed for job ${input.jobId}`, sweepErr);
    }
    return summarize("stopped", message);
  }
}
