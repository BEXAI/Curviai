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

import type { JobRecipeVariant } from "@curvi/db";
import { analyzeInventory, chooseInventoryTarget, deterministicLabel, noteSignals, unionBox, applyAddedOverlays, badgeEligible, buildPack, type NormalizedBox, type Shot } from "@curvi/pipeline";
import { channelFileLimit, getSpec, hasSpec } from "@curvi/specs";
import { ADDED_OVERLAYS_REASON, planFlagsOf, type ResolvedOutputOptions } from "@curvi/pipeline/output-options";
import {
  allSettledWithLimit,
  DEFAULT_SHOT_CONCURRENCY,
  JobAbandonedError,
  OUTPUT_OPTIONS_UNREADABLE,
  parseRunOutput,
  recordShotFailure,
  runShot,
  runOutOfTime,
  selectedFamilies,
  SHOT_CHANNEL_FULL,
  SHOT_NOT_DELIVERED,
  SHOT_OUT_OF_TIME,
  storeForRun,
  type BrandStyle,
  type PipelineDeps,
  type ShotContext,
  type ShotOutcome,
  type ShotPackAsset,
  type StoredFollowUpFiles,
  withRunDeadline,
} from "./pipeline-runner";
import type { JobRecipes } from "./recipes";
import { JobLedgerPlan, type LedgerAction } from "./state";
import { readSourceSelection, SourceSelectionUnavailableError, type SourceSelection } from "./source-selection";
export { readSourceSelection, SourceSelectionUnavailableError, SOURCE_SELECTION_UNAVAILABLE } from "./source-selection";
export type { SourceSelection } from "./source-selection";

export type PackFollowUpReason = "retry" | "add_angle" | "regenerate";

export interface PackFollowUpInput {
  /** Tells a follow up payload apart from a GeneratePackInput on a shared queue. */
  kind: "follow_up";
  /** Unique per follow up: its queue key, the prefix of its stored files,
   * and the generation_jobs.run_key the web app set when it queued it, which
   * every liveness check and ledger write of this run requires. */
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
  /** Workspace brand kit fonts, logo and style preset, as a first run gets. */
  brand?: BrandStyle;
  /** The recipe versions the job's first run was assigned
   * (generation_jobs.recipe_variants), so the follow up judges its shots
   * with the same QC recipe. The job's assignment when absent. */
  recipeVariants?: Record<string, JobRecipeVariant>;
  /** Draw the "Made with Curvi" badge on social exports, as the first run did. */
  socialBadge?: boolean;
  /** Files each channel spec already holds in the delivered pack, so new
   * files are numbered after them and no spec passes its image limit. */
  existingFilesBySpec: Record<string, number>;
  /** The job's provider spend before this follow up, in USD micros. The
   * job's COGS only ever grows, so the follow up reports the sum. */
  baseCostMicros: number;
  /** The job's stored output options (generation_jobs.output_options), with
   * the hexes createJob snapshotted, so a retried or added shot gets the
   * pack's colors and never a live kit read (PHASE_15 follow ups). Absent
   * means the defaults; anything the shared schema refuses stops the follow
   * up before any spend. */
  output?: ResolvedOutputOptions;
  /** Media ids of photos whose stored copy was written again at upload. */
  reencoded?: string[];
  /** The product box per photo, by media id (target_box, else the upload
   * preflight's productBox), for the P1 crop fit of kept photos. */
  productBoxes?: Record<string, NormalizedBox>;
  /** Media ids of kept photos the upload preflight saw added text, borders
   * or watermarks on (intake version 5). Their original_photo shots are
   * left off the specs that refuse those, as a first run leaves them. */
  addedOverlays?: string[];
  /** Versioned server-resolved selections. Optional only for reading old
   * queue payloads, which the worker refuses before generation. */
  sourceSelections?: Record<string, SourceSelection>;
  /** Newly added photos without upload intake. Resolve them from the same
   * cutout the priced shot reuses; never reinterpret an existing source. */
  resolveAddedSources?: string[];
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

/**
 * The follow up's shots with every kept photo in `addedOverlays` left off
 * the specs that refuse added text, borders or watermarks
 * (applyAddedOverlays, the first run's rule), whatever the web plan said.
 * `refused` holds the shots left with no spec at all; they do not run. Pure.
 */
export function followUpShotsWithoutOverlays(
  shots: readonly Shot[],
  output: ResolvedOutputOptions | null,
  addedOverlays: readonly string[] | undefined,
): { run: Shot[]; refused: Shot[] } {
  if (!output || !addedOverlays || addedOverlays.length === 0) {
    return { run: [...shots], refused: [] };
  }
  const flags = planFlagsOf(
    output,
    addedOverlays.map((id) => ({ id, addedOverlays: true })),
  );
  const run = applyAddedOverlays(shots, flags, []);
  const kept = new Set(run.map((shot) => shot.id));
  return { run, refused: shots.filter((shot) => !kept.has(shot.id)) };
}

/**
 * The recipes the follow up's shots run on: the versions the job recorded,
 * else the job's assignment, else the seed (undefined). A resolver failure
 * never stops the follow up.
 */
async function followUpRecipes(input: PackFollowUpInput, deps: PipelineDeps): Promise<JobRecipes | undefined> {
  const resolver = deps.recipes;
  if (!resolver) {
    return undefined;
  }
  try {
    const variants = input.recipeVariants;
    return variants && Object.keys(variants).length > 0 && resolver.forVariants
      ? await resolver.forVariants(input.jobId, variants)
      : await resolver.forJob(input.jobId);
  } catch (err) {
    console.error(`[follow-up] could not resolve the recipes of job ${input.jobId}; using the seed recipes`, err);
    return undefined;
  }
}

export async function runPackFollowUp(
  input: PackFollowUpInput,
  pipelineDeps: PipelineDeps,
): Promise<PackFollowUpSummary> {
  // Every store call of this follow up, its shots included, checks its run
  // key, so once a cancel and a newer follow up took the job over, nothing
  // this run does touches the job or the newer run's hold.
  const deps: PipelineDeps = { ...pipelineDeps, store: storeForRun(pipelineDeps.store, input.runKey) };
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
  const backToDone = async (runOutcome: "done" | "failed" = "done"): Promise<void> => {
    await store.setJobState(input.jobId, "done", { costMicros: input.baseCostMicros + costMicros, baseCostMicros: input.baseCostMicros, runOutcome });
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
    const parsedOutput = parseRunOutput(input.output);
    if (!parsedOutput.ok) {
      throw new Error(OUTPUT_OPTIONS_UNREADABLE);
    }
    await assertLive();
    const selections = [...new Set(input.shots.map((shot) => shot.sourceMediaId))].map((key) =>
      readSourceSelection(input.sourceSelections?.[key], key),
    );
    for (const key of input.resolveAddedSources ?? []) {
      const selection = selections.find((value) => value.sourceMediaId === key);
      if (input.reason !== "add_angle" || !selection || selection.target || !deps.generator.inventoryCutout) {
        throw new SourceSelectionUnavailableError();
      }
      await assertLive();
      if (runOutOfTime(deps)) throw new Error(SHOT_OUT_OF_TIME);
      const shot = input.shots.find((value) => value.sourceMediaId === key)!;
      const cutout = await deps.generator.inventoryCutout({ jobId: input.jobId, workspaceId: input.workspaceId, mediaId: key, shotId: shot.id });
      costMicros += cutout.costMicros;
      if (!cutout.cutout) throw new SourceSelectionUnavailableError();
      const inventory = analyzeInventory(cutout.cutout);
      const decision = chooseInventoryTarget({
        objects: inventory.objects, products: [],
        signals: noteSignals(null, { featureOnly: null, exclude: selection.exclude, mustKeep: [], styleNotes: null }),
      });
      if (decision.featured.length === 0 || decision.touching || ["ambiguous", "conflict", "none"].includes(decision.rule)) {
        throw new SourceSelectionUnavailableError();
      }
      const featured = decision.featured.map((index) => inventory.objects[index]);
      const keep = featured.map((object) => object.box);
      selection.target = {
        label: featured.map(deterministicLabel).join(" and "), box: unionBox(keep), keep,
        others: decision.removed.map((index) => ({ label: deterministicLabel(inventory.objects[index]), box: inventory.objects[index].box })),
      };
      selection.basis = "added_cutout_inventory";
    }
    const recipes = await followUpRecipes(input, deps);
    const ctx: ShotContext = {
      jobId: input.jobId,
      workspaceId: input.workspaceId,
      sku: input.sku,
      seoSlug: input.seoSlug,
      mode: input.mode ?? "listing",
      brandColors: input.brandColors,
      runKey: input.runKey,
      selectionBasis: Object.fromEntries(selections.map((selection) => [selection.sourceMediaId, selection.basis])),
      targets: Object.fromEntries(selections.flatMap((selection) =>
        selection.target ? [[selection.sourceMediaId, selection.target]] : [],
      )),
      exclude: [...new Set(selections.flatMap((selection) => selection.exclude))],
      otherItems: selections.filter((selection) => selection.otherItems).map((selection) => selection.sourceMediaId),
      ...(recipes ? { recipes } : {}),
      ...(input.brand ? { brand: input.brand } : {}),
      ...(parsedOutput.output ? { output: parsedOutput.output } : {}),
      ...(input.reencoded && input.reencoded.length > 0 ? { reencoded: [...input.reencoded] } : {}),
      ...(input.productBoxes && Object.keys(input.productBoxes).length > 0
        ? { productBoxes: { ...input.productBoxes } }
        : {}),
    };
    // One shot failing never takes its siblings down, as in a first run, and
    // an added angle's shots share the first run's concurrency limit.
    const runShots =
      deps.runShots ??
      (async (shots: Shot[], c: ShotContext): Promise<ShotOutcome[]> => {
        const gated = withRunDeadline(deps);
        const results = await allSettledWithLimit(shots, deps.shotConcurrency ?? DEFAULT_SHOT_CONCURRENCY, (s) =>
          runShot(s, c, gated),
        );
        return Promise.all(
          results.map((result, i) =>
            result.status === "fulfilled" ? result.value : recordShotFailure(store, shots[i], c, result.reason),
          ),
        );
      });
    // A kept photo with added text never reaches eBay or Google, even when
    // the plan it came with says so; a shot left with no channel ends in
    // needs review and its credits go back.
    const { run, refused } = followUpShotsWithoutOverlays(input.shots, parsedOutput.output, input.addedOverlays);
    const refusedOutcomes = await Promise.all(
      refused.map((shot) =>
        recordShotFailure(store, shot, ctx, new Error(ADDED_OVERLAYS_REASON), ADDED_OVERLAYS_REASON),
      ),
    );
    const outcomes = [...(run.length > 0 ? await runShots(run, ctx) : []), ...refusedOutcomes];
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
      const numbered = numberFollowUpFiles(passing, input.reason === "regenerate" ? {} : input.existingFilesBySpec);
      const { full } = numbered;
      const assets = numbered.assets.map((asset) =>
        input.socialBadge && badgeEligible(asset.specId) ? { ...asset, badge: true } : asset,
      );
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
          report: f,
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
    // The hold goes back before the job returns to done: once it is done a
    // newer follow up can start and reserve against the job, and a sweep
    // after that would take its hold too. The run key guards this as well.
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
    try {
      await backToDone("failed");
    } catch (stateErr) {
      console.error(`[follow-up] could not mark job ${input.jobId} done again`, stateErr);
    }
    return summarize("stopped", message);
  }
}
