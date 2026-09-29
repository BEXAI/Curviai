/**
 * Pure orchestration of the generate pack pipeline (CURVI_BUILD_PLAN.md
 * sections 4.4 and 5.5 to 5.7). Everything here is plain async code over
 * injected dependencies: the AI layer, a job store, a clock and a shot
 * generator. The Trigger.dev task files are thin wrappers around these
 * functions, so the whole flow is unit testable with @curvi/ai mocks.
 *
 * Flow: intake and analyze through the LLM recipes, plan shots (LLM planner,
 * validated and repriced from the seed, with the deterministic planner as
 * fallback), fit every shot to the selected channel specs (undeliverable
 * methods out first, then the selection, channel file limits and the
 * budget), fan out per shot generation, QC each channel output of each shot
 * with deterministic pixel checks on the shipped bytes plus a fidelity
 * report and the planRetry loop, package via buildPack, and account for
 * credits with JobLedgerPlan: reserve on queued, charge each shot whose file
 * is in the delivered pack, release for shots that need review, shots the
 * packager left out, and on failure. One failing shot never fails the pack;
 * a pack fails only when nothing can be delivered. Provider spend, billed
 * failures included, is booked on the shot and the job (COGS).
 */

import {
  AllProvidersFailedError,
  billedMicrosOf,
  callWithFailover,
  hasProviderErrorCode,
  providerErrorsOf,
  type BreakerStore,
  type CallWithFailoverOptions,
  type CapsHook,
  type CostMeter,
  type ProviderRegistry,
  type RoutingTable,
  type SpendCaps,
} from "@curvi/ai";
import {
  badgeEligible,
  applyBrandStylePreset,
  buildPack,
  capShotsPerChannel,
  CHANNEL_LIMIT_REASON,
  channelLimitViolations,
  channelOf,
  decodeToRgba,
  fidelityReport,
  HarmonizeAspectError,
  pixelChecks,
  planRetry,
  encodeVisionJpeg,
  mediaIdsByAngle,
  NO_BOX_CONTENTS_REASON,
  NO_COMPARISON_FACTS_REASON,
  planShots,
  printableSellerLines,
  qcKindForSpec,
  significantComponents,
  trimToBudget,
  withSellerAngles,
  IntakeResult,
  IntakeToolResult,
  ProductProfile,
  QCVerdict,
  ShotList,
  strictToolSchema,
  type AngleRole,
  type DigitalSourceKind,
  type FidelityReport,
  type NormalizedBox,
  type PackAsset,
  type SellerIntent,
  analyzeInventory,
  chooseInventoryTarget,
  inventoryRecord,
  matchProducts,
  itemLabel,
  noteSignals,
  unionBox,
  needsVisionPick,
  pickerNumbering,
  PICKER_MAX_PIECES,
  PICKER_MIN_PIECES,
  plainReason,
  renderContactSheet,
  visionDecision,
  TargetPick,
  TargetPickAnswer,
  type VisionPick,
  type VisionPickRecord,
  type IntakeProduct,
  type InventoryDecision,
  type CutoutInventory,
  type JobInventory,
  type PackInventoryPhoto,
  type PhotoInventory,
  type PixelCheckReport,
  type PlanOptions,
  type RawImage,
  type RawMask,
  type Shot,
} from "@curvi/pipeline";
import { creditCosts, recipeSeedRows, type RecipeRow, type TierKey } from "@curvi/pipeline/seed";
import {
  getSpec,
  hasSpec,
  isMarketplaceChannel,
  isMarketplaceSpec,
  isSpecSelected,
  type ChannelSpec,
} from "@curvi/specs";
import { z } from "zod";
import { ShotFailedAfterSpendError, ShotUnavailableError } from "./errors";
import { isWorkspaceObjectKey } from "./object-keys";
import {
  llmModelProviderName,
  recipeFor,
  recipeVariantsOf,
  seedJobRecipes,
  type JobRecipes,
  type RecipeResolver,
  type ResolvedRecipe,
} from "./recipes";
import {
  canvasSizeFor,
  decodeMaskPng,
  encodeMaskPng,
  measureBackgroundRgb,
  QC_EDGE_MARGIN_PX,
} from "./shot-outputs";
import { isTerminal, JobLedgerPlan, transition, type JobState, type LedgerAction } from "./state";
import { DEFAULT_SHOT_CONCURRENCY } from "./shot-concurrency";

export type { JobState } from "./state";
export { ShotFailedAfterSpendError, ShotUnavailableError } from "./errors";

/** Plain copy for a shot that ended on an unexpected provider or runtime error. */
export const SHOT_PROVIDER_TROUBLE = "Our image provider had trouble with this shot, so it needs review.";
/** Plain copy for a shot an image provider's safety system declined (Update.md 5.4). */
export const SHOT_CONTENT_BLOCKED = "The image service declined to make this scene, so this shot needs review.";
/** Plain copy for a passing shot the packager left out because its channel
 * already had as many images as it allows (Update.md 2.10). */
export const SHOT_CHANNEL_FULL =
  "This channel already has as many images as it allows, so this one was left out of the pack and not charged.";
/** Plain copy for a passing shot the packager left out for another reason. */
export const SHOT_NOT_DELIVERED = "This image could not be added to the pack, so it was left out and not charged.";
/** Skipped reason for shots whose method no live provider delivers yet. */
export const PROVIDER_NOT_ENABLED = "provider not enabled";
/** Skipped reason for shots none of whose channel specs the seller picked. */
export const CHANNEL_NOT_SELECTED = "channel not selected";
/** Plain copy for a shot the pack spend cap stopped before it ran. */
const PACK_CAP_REACHED =
  "This pack reached its spending limit before this shot could be made, so it needs review.";

/** Compiled seed recipe row for a pipeline stage, so task names, models and
 * prompts are never hardcoded here (CLAUDE.md rule 2). Runs read the recipes
 * table through PipelineDeps.recipes; this is the seed the demo wiring and
 * the fallback use. */
export function activeRecipe(stage: RecipeRow["stage"]): RecipeRow {
  const recipe = recipeSeedRows.find((r) => r.stage === stage && r.active);
  if (!recipe) {
    throw new Error(`No active recipe seeded for stage "${stage}"`);
  }
  return recipe;
}

/** Everything callWithFailover needs, injected as one bundle. */
export interface AiDeps {
  registry: ProviderRegistry;
  routing: RoutingTable;
  meter: CostMeter;
  breakerStore: BreakerStore;
  /** When present, every routed call reserves against the pack and global
   * day caps, and each shot's generation cost is gated by the per asset caps
   * (plan 4.4). Providers must estimate costs; unestimated calls fail closed. */
  caps?: SpendCaps;
  /** Passed to every routed call (Update.md 5.7): called with the global
   * daily total when a reservation reaches the alert line. The runtime wires
   * it to the founder spend alert, which dedupes per day. */
  onCapAlert?: (globalDayTotalMicros: number) => void;
  /** Passed to every routed call: receives the bookkeeping errors the router
   * swallows (meter, breaker, release, alert). Wire it to error reporting. */
  onInternalError?: (err: unknown, context: string) => void;
}

/** The alert and error hooks every routed call carries. */
export function routedCallHooks(ai: AiDeps): Pick<CallWithFailoverOptions, "onCapAlert" | "onInternalError"> {
  return {
    ...(ai.onCapAlert ? { onCapAlert: ai.onCapAlert } : {}),
    ...(ai.onInternalError ? { onInternalError: ai.onInternalError } : {}),
  };
}

/** The cap layers for a routed LLM call: the job's pack budget plus the
 * global daily provider spend. */
function llmCapsHooks(ai: AiDeps): CapsHook[] | undefined {
  if (!ai.caps) {
    return undefined;
  }
  return [
    { spendCaps: ai.caps, capKind: "pack" },
    { spendCaps: ai.caps, capKind: "global_day" },
  ];
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Ledger entry as persisted by the job store. */
export interface JobLedgerEntry extends LedgerAction {
  jobId: string;
  workspaceId: string;
  at: Date;
}

/** Measured compliance values for the green badge (plan 3.3.3): the exact
 * fill percentage and background the checks saw, not just pass or fail. */
export interface MeasuredCompliance {
  fillPct: number | null;
  background: [number, number, number] | null;
}

export interface StoredAsset {
  jobId: string;
  workspaceId: string;
  shotId: string;
  shotType: Shot["type"];
  specId: string;
  status: "passed" | "needs_review";
  attempts: number;
  credits: number;
  costMicros: number;
  verdict: QCVerdict;
  measured: MeasuredCompliance;
  /** Final encoded image for passed shots, so stores can persist the pixels. */
  encoded?: { buffer: Buffer; format: string };
  /** The planned shot itself, so a shot that needs review can be run again
   * later exactly as planned (pack follow ups, trigger/src/follow-up.ts). */
  shot?: Shot;
}

/** The plan as the progress board needs it: every shot the pack will try,
 * and every shot the planner left out with its reason. */
export interface StoredPlan {
  jobId: string;
  workspaceId: string;
  shots: Shot[];
  skipped: Array<{ type: string; reason: string }>;
}

export interface StoredPack {
  jobId: string;
  workspaceId: string;
  outDir: string;
  channels: string[];
  files: number;
  reportPath: string;
}

/** Minimal persistence interface. The app wires this to @curvi/db; tests and
 * demo mode use the in memory implementation below. */
export interface JobStore {
  /** Returns false when the job already reached a terminal state elsewhere
   * (for example the stale run reconciler failed it); the runner then stops
   * instead of spending on a job nobody will settle. */
  setJobState(jobId: string, state: JobState, meta?: Record<string, unknown>): Promise<boolean | void>;
  appendLedger(entry: JobLedgerEntry): Promise<void>;
  saveAsset(asset: StoredAsset): Promise<void>;
  savePack(pack: StoredPack): Promise<void>;
  /** Persists the analyzed ProductProfile; stores without product rows skip it. */
  saveProfile?(jobId: string, profile: ProductProfile): Promise<void>;
  /** Records the planned shots as pending and the skipped ones with their
   * reasons, so the board shows the whole pack before any shot finishes.
   * Display only: the runner never fails a pack because this failed. */
  savePlan?(plan: StoredPlan): Promise<void>;
  /** Marks the run alive between state changes so a long generation phase
   * never looks stale to the reconciler. Returns false once the job is
   * terminal, so shots stop spending on a job nobody will settle. */
  heartbeat?(jobId: string): Promise<boolean | void>;
  /** Failure path safety sweep: returns every credit the ledger still holds
   * for the job, whatever the in process plan believes is outstanding. */
  releaseAllHeld?(jobId: string, workspaceId: string): Promise<void>;
  /** A shot that passed QC but whose files the packager left out (a channel
   * image limit): its asset row turns into needs review with reason, so the
   * board never shows a delivered, charged card for it. Display only: the
   * runner releases its credits whatever this does. */
  markShotUndelivered?(update: UndeliveredShot): Promise<void>;
  /** Records which recipe version each stage runs on (A/B assignment).
   * Display and analysis only: the runner never fails a pack because this
   * failed. */
  saveRecipeVariants?(jobId: string, variants: ReturnType<typeof recipeVariantsOf>): Promise<void>;
  /** Records the seller intent intake parsed from the note
   * (generation_jobs.seller_intent), only while the job is live and this
   * run's, so follow ups and retries keep what the seller asked for. The
   * runner never fails a pack because this failed. */
  saveSellerIntent?(jobId: string, intent: SellerIntent): Promise<void>;
  /** Records what the product inventory found in each photo
   * (generation_jobs.inventory), with the same liveness rule as
   * saveSellerIntent. The runner never fails a pack because this failed. */
  saveInventory?(jobId: string, inventory: JobInventory): Promise<void>;
  /** Delivers the files of a pack follow up (a retried shot or an added
   * angle) into a pack that was already delivered: uploads them and records
   * their asset_variants rows, only while the job is live, like savePack.
   * No new report row: the pack was delivered by its first run. Returns the
   * shot ids whose files were recorded; only those are charged. */
  saveFollowUpFiles?(files: StoredFollowUpFiles): Promise<string[]>;
  /** This store bound to one run's key (generation_jobs.run_key): its
   * heartbeat, state writes, delivery checks and ledger writes then refuse
   * a job that belongs to another run, so a stale runner of an earlier run
   * stops even after a follow up moved the job back to generating. Stores
   * without run keys (in memory, demo) leave it out. */
  forRun?(runKey: string): JobStore;
}

/** The store bound to a run's key, when the run has one and the store knows
 * run keys; the store itself otherwise (a payload queued before run keys). */
export function storeForRun(store: JobStore, runKey: string | null | undefined): JobStore {
  return runKey && store.forRun ? store.forRun(runKey) : store;
}

/** The loose files one pack follow up built, ready to deliver. */
export interface StoredFollowUpFiles {
  jobId: string;
  workspaceId: string;
  /** Unique per follow up; keeps its storage keys apart from every other run. */
  runKey: string;
  outDir: string;
  /** Channel family, file name, spec and shot id of each file to deliver. */
  files: Array<{ channel: string; file: string; specId: string; ref: string; width: number | null; height: number | null }>;
}

/** A passing shot the packager did not deliver, and why (plain copy). */
export interface UndeliveredShot {
  jobId: string;
  workspaceId: string;
  shotId: string;
  shotType: Shot["type"];
  reason: string;
}

/** True when a provider chain failed because a spend cap refused at least
 * one provider, or the cap reservation could not be made (fail closed). The
 * remaining providers failing too (breaker open, outage) does not change
 * that the cap is what stopped the shot, so it goes to needs review rather
 * than failing the whole pack. Reads the router's error codes, never text. */
export function isSpendCapBlock(err: unknown): boolean {
  return (
    err instanceof AllProvidersFailedError &&
    (hasProviderErrorCode(err, "cap_blocked") || hasProviderErrorCode(err, "cap_unavailable"))
  );
}

/**
 * Provider spend a failed provider call or generation still incurred, in USD
 * micros: the router's billed total for a failed chain (billedMicrosOf), or
 * the paid but rejected output a HarmonizeAspectError reports, whichever is
 * larger per error so nothing is counted twice. Added to the shot or job
 * cost so COGS matches what the spend caps hold.
 */
export function failureSpendMicros(err: unknown): number {
  const perError = providerErrorsOf(err).reduce(
    (sum, e) => sum + Math.max(e.billedCostMicros, e instanceof HarmonizeAspectError ? e.costMicros : 0),
    0,
  );
  return Math.max(billedMicrosOf(err), perError);
}

/**
 * Splits a generator failure into the error to handle and the provider
 * spend it carries: a refusal's own cost, the spend a
 * ShotFailedAfterSpendError wraps, or the billed cost of a raw provider
 * failure.
 */
export function generationFailure(err: unknown): { error: unknown; costMicros: number } {
  if (err instanceof ShotUnavailableError) {
    return { error: err, costMicros: err.costMicros };
  }
  if (err instanceof ShotFailedAfterSpendError) {
    return { error: err.original, costMicros: err.costMicros };
  }
  return { error: err, costMicros: failureSpendMicros(err) };
}

/** The job reached a terminal state outside this run; stop working on it. */
export class JobAbandonedError extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId} was already finished or failed elsewhere, so this run stopped`);
    this.name = "JobAbandonedError";
  }
}

export class InMemoryJobStore implements JobStore {
  readonly states: Array<{ jobId: string; state: JobState; meta?: Record<string, unknown> }> = [];
  readonly recipeVariants = new Map<string, ReturnType<typeof recipeVariantsOf>>();
  readonly ledger: JobLedgerEntry[] = [];
  readonly assets: StoredAsset[] = [];
  readonly packs: StoredPack[] = [];
  readonly followUps: StoredFollowUpFiles[] = [];
  readonly sellerIntents = new Map<string, SellerIntent>();

  readonly inventories = new Map<string, JobInventory>();

  async saveSellerIntent(jobId: string, intent: SellerIntent): Promise<void> {
    this.sellerIntents.set(jobId, intent);
  }

  async saveInventory(jobId: string, inventory: JobInventory): Promise<void> {
    this.inventories.set(jobId, inventory);
  }

  async setJobState(jobId: string, state: JobState, meta?: Record<string, unknown>): Promise<boolean> {
    this.states.push({ jobId, state, meta });
    return true;
  }

  async appendLedger(entry: JobLedgerEntry): Promise<void> {
    this.ledger.push(entry);
  }

  async saveAsset(asset: StoredAsset): Promise<void> {
    this.assets.push(asset);
  }

  async savePack(pack: StoredPack): Promise<void> {
    this.packs.push(pack);
  }

  async saveFollowUpFiles(files: StoredFollowUpFiles): Promise<string[]> {
    this.followUps.push(files);
    return [...new Set(files.files.map((f) => f.ref))];
  }

  async saveRecipeVariants(jobId: string, variants: ReturnType<typeof recipeVariantsOf>): Promise<void> {
    this.recipeVariants.set(jobId, variants);
  }

  async markShotUndelivered(update: UndeliveredShot): Promise<void> {
    for (const asset of this.assets) {
      if (asset.jobId === update.jobId && asset.shotId === update.shotId) {
        asset.status = "needs_review";
        asset.encoded = undefined;
        asset.verdict = { ...asset.verdict, pass: false, repairHint: update.reason.slice(0, 300) };
      }
    }
  }
}

/** One generated candidate for a shot, before QC. */
export interface ShotGeneration {
  /** Final composed canvas, raw RGBA. */
  image: RawImage;
  /** Product mask at canvas scale, when the method produces one. */
  mask: RawMask | null;
  /** Canvas holding the exact product pixels that must survive; required for
   * composite and edit methods so fidelityReport can prove the paste back. */
  productReference?: RawImage;
  encoded: { buffer: Buffer; format: string };
  costMicros: number;
  /** True when rule 3 must be proven for this output even though its method
   * is not a composite (live stills in Listing Mode). */
  fidelityRequired?: boolean;
  /** Mask erosion for the fidelity check. Generators derive it from how the
   * product was placed (the paste erosion a composite applied, the scale a
   * still was resized by) with an area floor, so thin products keep a real
   * check region. Interior pixels are always checked strictly. */
  fidelityErodePx?: number;
  /** The lowest the fidelity erosion may go when this output is re-framed
   * for another channel: below it pixels may be blended with the background. */
  fidelityErodeFloorPx?: number;
  /** The canvas before encoding, when it differs from image (a lossy file);
   * other channel outputs are derived from it, never from decoded JPEG. */
  canvas?: RawImage;
  /** True when the generator reserved its provider spend against the caps
   * before each call; runShot then skips its after the fact reservation so
   * the spend is not counted twice. */
  spendReserved?: boolean;
}

export interface ShotGenerateArgs {
  shot: Shot;
  attempt: number;
  repairHint?: string;
  /** True on the extra attempt after 3 failures (plan 5.6 retry policy). */
  useFallbackProvider: boolean;
  jobId: string;
  workspaceId: string;
  /** Workspace brand kit colors (hex), for brand colored stills. */
  brandColors?: string[];
  /** Workspace brand kit fonts and logo, for template stills. */
  brand?: BrandStyle;
  /** The product in the shot's photo this pack is for, when intake found
   * more than one or matched the seller's note (docs/phases/PHASE_13.md). */
  target?: ProductTarget;
}

/**
 * The product in one photo a pack is for. With a box, the photo showed other
 * products too and every delivered still must hold only this product.
 * Without a box the photo showed only this product and is used whole,
 * exactly as before.
 *
 * With keep (a target the product inventory chose), the generator cuts out
 * the whole photo once and keeps exactly the cutout pieces at those boxes,
 * zeroing the others; box is then their union. Without keep (an intake only
 * target, when no inventory ran), it crops to box before the cutout and
 * keeps the pieces overlapping it.
 */
export interface ProductTarget {
  label: string;
  box: NormalizedBox | null;
  /** The other products in the photo, which are removed from every image. */
  others: Array<{ label: string; box: NormalizedBox }>;
  /** The inventory pieces the pack features, normalized to the upright
   * working photo. */
  keep?: NormalizedBox[];
  /** True when the featured piece also holds another product (they touch):
   * every shot of the photo is refused at no charge. */
  touching?: boolean;
}

/** The whole photo cut out for the product inventory, and the provider
 * spend it booked for the caller (zero once already booked). */
export interface InventoryCutout {
  /** The upright working photo's cutout, RGBA; null when the cutout was
   * unusable or could not be made (the pack then runs without inventory). */
  cutout: RawImage | null;
  costMicros: number;
}

/**
 * The brand kit parts packs use beyond colors: template font keys
 * (seed/fonts.ts), the logo's object key in the workspace's private bucket,
 * and a style preset key, or "auto" to let the planner pick.
 */
export interface BrandStyle {
  fonts?: { heading?: string | null; body?: string | null };
  logoKey?: string | null;
  stylePreset?: string | null;
}

export interface ShotGenerator {
  generate(args: ShotGenerateArgs): Promise<ShotGeneration>;
  /**
   * Builds this shot's output for another channel spec from an accepted
   * generation, without new provider spend (Update.md 2.11). Optional: a
   * generator without it is asked to generate that spec directly.
   */
  deriveForSpec?(args: ShotGenerateArgs, from: ShotGeneration, specId: string): Promise<ShotGeneration>;
  /**
   * Cuts out a whole photo for the product inventory, once per job and
   * photo: the shots of that photo reuse the same cutout, so it is paid for
   * once. Optional: a generator without a cutout (the demo) skips the
   * inventory and the pack runs exactly as before. Never throws.
   */
  inventoryCutout?(args: { jobId: string; workspaceId: string; mediaId: string }): Promise<InventoryCutout>;
}

export interface ShotContext {
  jobId: string;
  workspaceId: string;
  sku?: string;
  seoSlug?: string;
  /** Listing or concept; concept packs mark every generated output as fully
   * synthetic (plan 2.7). Defaults to listing when omitted. */
  mode?: "listing" | "concept";
  /** Workspace brand kit colors (hex), passed through to the generator. */
  brandColors?: string[];
  /** The recipe variants this job was assigned, so a shot subtask judges
   * with the same QC recipe as the pack. The seed when absent. */
  recipes?: JobRecipes;
  /** Workspace brand kit fonts and logo, passed through to the generator. */
  brand?: BrandStyle;
  /** The run's key (generation_jobs.run_key), so a shot, in process or in a
   * fan out subtask, checks liveness against its own run. */
  runKey?: string;
  /** The product each photo is for, by media id (docs/phases/PHASE_13.md).
   * A photo without an entry is used whole, as before. */
  targets?: Record<string, ProductTarget>;
  /** What the seller asked to leave out, from the parsed note. The QC judge
   * sees it as data next to the target's label. */
  exclude?: string[];
}

/** IPTC digital source marking per plan 5.7.2: composited scenes carry
 * compositeSynthetic, fully generated outputs carry trainedAlgorithmicMedia,
 * deterministic edits of the user's photo carry no AI tag. Concept mode has no
 * real photo, so every generative method is fully synthetic. */
export function digitalSourceFor(
  method: Shot["method"],
  mode: ShotContext["mode"],
): DigitalSourceKind {
  if (method === "deterministic" || method === "template") {
    return "none";
  }
  if (mode === "concept") {
    return "trained";
  }
  if (method === "composite_generate" || method === "edit_generate") {
    return "composite";
  }
  return "trained";
}

/** QC result for one channel output of a shot (Update.md 2.11). */
export interface ShotOutputSummary {
  specId: string;
  status: "passed" | "needs_review";
  attempts: number;
  usedFallbackProvider: boolean;
  verdict: QCVerdict;
  pixelPass: boolean;
  fidelityPass: boolean | null;
  measured: MeasuredCompliance;
}

/**
 * One shot, possibly delivered to several channels. The top level QC fields
 * describe the representative output (the first that passed, else the
 * first tried); outputs lists every channel output. A shot passes, and is
 * charged once, when at least one of its channel outputs passes.
 */
export interface ShotOutcomeBase {
  shotId: string;
  shotType: Shot["type"];
  specId: string;
  credits: number;
  status: "passed" | "needs_review";
  attempts: number;
  usedFallbackProvider: boolean;
  costMicros: number;
  verdict: QCVerdict;
  pixelPass: boolean;
  fidelityPass: boolean | null;
  digitalSource: DigitalSourceKind;
  measured: MeasuredCompliance;
  outputs: ShotOutputSummary[];
  /** Internal detail when the shot ended on an unexpected error; for logs
   * and the job error, never used as shot copy. */
  failure?: string;
}

/**
 * One delivered file as the runner holds it until packaging: the encoded
 * bytes that ship plus the product mask as a PNG, never decoded pixels. A
 * 2000 px RGBA canvas is 16 MB while its file is a few hundred KB, and every
 * shot of a pack runs at once, so buildPack decodes each file through
 * loadPixels only when it checks it (Update.md 2.15, inline runner memory).
 */
export type ShotPackAsset = PackAsset & {
  /** The product mask as a single channel PNG, for the pack side checks and
   * the subtask boundary. */
  maskPng?: Buffer;
};

export interface ShotOutcome extends ShotOutcomeBase {
  /** One file per passing channel output; feeds buildPack. */
  packAssets?: ShotPackAsset[];
}

/** One delivered file in JSON safe form. */
export interface SerializedPackFile {
  specId: string;
  encodedBase64: string;
  format?: string;
  /** The product mask as a single channel PNG, so the pack task can rerun
   * the pixel checks on the decoded file (Update.md 2.15). */
  maskPngBase64?: string;
  edgeMarginPx?: number;
}

/** JSON safe form of a shot outcome for the Trigger.dev subtask boundary. */
export interface SerializableShotOutcome extends ShotOutcomeBase {
  files?: SerializedPackFile[];
}

export async function serializeShotOutcome(outcome: ShotOutcome): Promise<SerializableShotOutcome> {
  const { packAssets, ...base } = outcome;
  if (!packAssets || packAssets.length === 0) {
    return base;
  }
  const files = await Promise.all(
    packAssets.map(async (asset): Promise<SerializedPackFile> => {
      const maskPng = asset.maskPng ?? (asset.mask ? await encodeMaskPng(asset.mask) : undefined);
      return {
        specId: asset.specId,
        encodedBase64: asset.buffer.toString("base64"),
        ...(asset.format !== undefined ? { format: asset.format } : {}),
        ...(maskPng ? { maskPngBase64: maskPng.toString("base64") } : {}),
        ...(asset.edgeMarginPx !== undefined ? { edgeMarginPx: asset.edgeMarginPx } : {}),
      };
    }),
  );
  return { ...base, files };
}

/**
 * Decodes a delivered file for the pack side checks: the pixels of the bytes
 * that ship and the mask from its PNG. buildPack calls it one file at a time.
 */
export function lazyPackPixels(maskPng: Buffer | undefined): NonNullable<PackAsset["loadPixels"]> {
  return async (bytes: Buffer) => {
    const raw = await decodeToRgba(bytes);
    // A mask that no longer decodes costs the mask aware checks, not the file.
    const mask = maskPng ? await decodeMaskPng(maskPng).catch(() => undefined) : undefined;
    return mask ? { raw, mask } : { raw };
  };
}

/**
 * Rebuilds pack assets on the pack task side. Nothing is decoded here: the
 * packager decodes each shipped file (the bytes QC measured in the subtask)
 * and its mask when it checks it, so the compliance report keeps its
 * measured pixel checks in Trigger mode without holding every canvas.
 */
export async function deserializeShotOutcome(
  serialized: SerializableShotOutcome,
  ctx: ShotContext,
): Promise<ShotOutcome> {
  const { files, ...base } = serialized;
  const outcome: ShotOutcome = { ...base, outputs: base.outputs ?? [] };
  if (base.status !== "passed" || !files || files.length === 0) {
    return outcome;
  }
  outcome.packAssets = files.map((file): ShotPackAsset => {
    const buffer = Buffer.from(file.encodedBase64, "base64");
    const maskPng = file.maskPngBase64 ? Buffer.from(file.maskPngBase64, "base64") : undefined;
    return {
      specId: file.specId,
      buffer,
      format: file.format,
      ...(maskPng ? { maskPng } : {}),
      loadPixels: lazyPackPixels(maskPng),
      ...(file.edgeMarginPx !== undefined ? { edgeMarginPx: file.edgeMarginPx } : {}),
      sku: ctx.sku,
      seoSlug: ctx.seoSlug,
      ref: base.shotId,
      digitalSource: base.digitalSource,
    };
  });
  return outcome;
}

export interface PipelineDeps {
  ai: AiDeps;
  /** Assigns each job its recipe variants from the recipes table. The
   * compiled seed recipes run when absent (demo mode and tests). */
  recipes?: RecipeResolver;
  store: JobStore;
  clock: Clock;
  generator: ShotGenerator;
  /** Loads source media bytes for LLM vision input; metadata only when absent. */
  loadMedia?: (mediaId: string) => Promise<Buffer | null>;
  /** Shot methods no live provider delivers yet (video, avatar). They are
   * sent to both planners as undeliverableMethods and removed from either
   * plan before any budget check, so they never take a deliverable shot's
   * place (Update.md 1.7). */
  excludeShotMethods?: Array<Shot["method"]>;
  /** Spend ceiling per shot including retries; further attempts stop at it. */
  assetCostCapMicros?: number;
  /** Spend ceiling for the whole pack; the run fails when it is crossed. */
  packCostCapMicros?: number;
  /** Fan out override: the Trigger.dev wrapper points this at the
   * generate-shot subtask. Defaults to Promise.allSettled over runShot, with
   * a shot that throws turned into a needs review outcome. */
  runShots?: (shots: Shot[], ctx: ShotContext) => Promise<ShotOutcome[]>;
  /** Shots the default fan out runs at once (DEFAULT_SHOT_CONCURRENCY when
   * unset). Every running shot holds decoded RGBA copies of the product, so
   * an unbounded fan out of a 20 shot pack ran a 512 MB instance out of
   * memory. */
  shotConcurrency?: number;
  /** Where buildPack writes zips. A temp dir when omitted. */
  packOutDir?: string;
  /** Called when the global daily spend crosses the alert line (plan 4.4:
   * $50 alert). Defaults to a console warning in the runtime wiring. */
  onSpendAlert?: (totalMicros: number) => void;
}

export { DEFAULT_SHOT_CONCURRENCY };

/** Promise.allSettled over items with at most `limit` calls in flight,
 * results in input order. */
export async function allSettledWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i] as T) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

export interface GeneratePackInput {
  jobId: string;
  workspaceId: string;
  tier: TierKey;
  /** Listing (default) or concept. Concept packs never target marketplace
   * channels and mark every generated output TrainedAlgorithmicMedia. */
  mode?: "listing" | "concept";
  /** Channel families or spec ids, e.g. ["amazon", "shopify"]. */
  channels: string[];
  creditBudget: number;
  /** The pack's photos. angle is the role the seller picked for the photo
   * (front, back, side, detail, in_the_box, scale), when they picked one. */
  images: Array<{ mediaId: string; url?: string; angle?: AngleRole }>;
  userDescription?: string;
  sku?: string;
  seoSlug?: string;
  /** Older payload flags. The in_the_box and comparison shots are planned
   * only when boxContents or comparisonFacts has a printable line, since
   * those images print nothing else. */
  hasBoxContents?: boolean;
  hasComparisonFacts?: boolean;
  /** What is in the box, one item per line, exactly as the seller typed it.
   * Printed on the in_the_box image; a non empty list implies hasBoxContents. */
  boxContents?: string[];
  /** Comparison facts the seller can back up, printed on the comparison
   * image; a non empty list implies hasComparisonFacts. */
  comparisonFacts?: string[];
  hasVideoSource?: boolean;
  /** Workspace brand kit colors (hex), for brand colored stills. */
  brandColors?: string[];
  /** Draw the "Made with Curvi" badge on social exports (plan 9.6.3). The
   * packager draws it only on badgeAllowed social specs, clear of the
   * product, so marketplace files never carry it. */
  socialBadge?: boolean;
  /** Workspace brand kit fonts, logo and style preset. */
  brand?: BrandStyle;
  /** The key the web app set on generation_jobs.run_key when it queued this
   * run. Absent on payloads queued before run keys (status checks only). */
  runKey?: string;
}

export interface GeneratePackSummary {
  jobId: string;
  state: "done" | "failed";
  reservedCredits: number;
  chargedCredits: number;
  releasedCredits: number;
  passed: number;
  needsReview: number;
  plannedShots: number;
  skipped: Array<{ type: string; reason: string }>;
  plannerSource: "llm" | "deterministic" | null;
  /** Why the LLM plan was not used, when the deterministic planner ran instead. */
  planRejection?: string;
  costMicros: number;
  pack: StoredPack | null;
  error?: string;
}

/** Input shape sent to LLM providers, compatible with the Anthropic adapter.
 * No model field: each provider in the recipe's failover chain runs its own
 * model, so a request pinned to the primary would break the fallbacks. */
export interface LlmTaskInput {
  system: string;
  /** Content is a string, or an array of vision and text blocks. */
  messages: Array<{ role: "user" | "assistant"; content: unknown }>;
  /** Forced structured output tool definitions, when a schema is enforced. */
  tools?: unknown[];
  toolChoice?: unknown;
  /** Output token budget from the recipe body; the adapter default otherwise. */
  maxTokens?: number;
}

function sniffImageMime(bytes: Buffer): string {
  if (bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length > 11 && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length > 3 && bytes.toString("ascii", 0, 3) === "GIF") return "image/gif";
  return "image/jpeg";
}

/** Photos the product analyzer sees as images. */
export const ANALYZE_PHOTO_LIMIT = 3;

/** Photos intake sees as images: every photo a pack can carry (the web app's
 * MAX_PACK_PHOTOS), so its per image screenshot verdict covers each one. */
export const INTAKE_PHOTO_LIMIT = 6;

/**
 * The photos intake judges, in the order its per image verdicts come back:
 * the photos it was shown when any loaded (so the text list lines up with
 * the images), else the pack's whole list, sent as metadata only.
 */
export function intakeImages(
  images: GeneratePackInput["images"],
  shown: ReadonlyArray<{ mediaId: string }>,
): GeneratePackInput["images"] {
  if (shown.length === 0) {
    return images;
  }
  const byId = new Map(images.map((image) => [image.mediaId, image]));
  return shown.flatMap((photo) => {
    const image = byId.get(photo.mediaId);
    return image ? [image] : [];
  });
}

/**
 * Anthropic vision blocks for the uploaded photos, so intake and the product
 * analyzer judge the actual pixels instead of metadata. Empty when the deps
 * carry no media loader (demo mode) or nothing loads. Only keys under the
 * job's own workspace prefix are ever loaded (Update.md 4.1): the loader
 * reads with owner credentials, so another tenant's key is skipped.
 */
export async function visionBlocks(
  deps: Pick<PipelineDeps, "loadMedia">,
  images: GeneratePackInput["images"],
  workspaceId: string,
  limit = ANALYZE_PHOTO_LIMIT,
): Promise<unknown[]> {
  return (await visionPhotos(deps, images, workspaceId, limit)).map((photo) => photo.block);
}

/** visionBlocks with the media id each block shows, in the order sent, so
 * a per image verdict (intake's screenshot flag) maps back to its photo. */
async function visionPhotos(
  deps: Pick<PipelineDeps, "loadMedia">,
  images: GeneratePackInput["images"],
  workspaceId: string,
  limit = ANALYZE_PHOTO_LIMIT,
): Promise<Array<{ mediaId: string; block: unknown }>> {
  if (!deps.loadMedia) {
    return [];
  }
  const photos: Array<{ mediaId: string; block: unknown }> = [];
  const owned = images.filter((image) => isWorkspaceObjectKey(workspaceId, image.mediaId));
  if (owned.length < images.length) {
    console.warn(`[runner] skipped ${images.length - owned.length} photo keys outside workspace ${workspaceId}`);
  }
  for (const image of owned.slice(0, limit)) {
    const bytes = await deps.loadMedia(image.mediaId).catch(() => null);
    if (!bytes || bytes.length === 0) {
      continue;
    }
    // Normalize to a bounded JPEG; a raw upload can exceed the vision API's
    // per image size limit. Fall back to the original if decoding fails.
    const normalized = await encodeVisionJpeg(bytes).catch(() => bytes);
    const mediaType = normalized === bytes ? sniffImageMime(bytes) : "image/jpeg";
    photos.push({
      mediaId: image.mediaId,
      block: {
        type: "image",
        source: { type: "base64", media_type: mediaType, data: normalized.toString("base64") },
      },
    });
  }
  return photos;
}

/** Job error when intake judged every photo in the pack a screenshot or
 * screen capture (docs/phases/PHASE_12.md A5). Credits held for the pack are
 * released by the failure path; the web app maps it to seller copy. */
export const SCREENSHOT_UPLOAD_MESSAGE =
  "Every photo in this pack looks like a screenshot, not a photo of the product, so nothing was charged.";

/**
 * Media ids intake flagged as screenshots. Intake answers one entry per
 * image it was shown, in order: the vision photos when any loaded, else the
 * pack's image list. When the entry count does not match, which photo an
 * entry means is unknown, so none is dropped here; the pack still fails when
 * every entry is a screenshot.
 */
export function screenshotMediaIds(intake: IntakeResult, judged: readonly string[], jobId: string): Set<string> {
  const flagged = new Set<string>();
  if (!intake.images.some((image) => image.screenshot === true)) {
    return flagged;
  }
  if (intake.images.length !== judged.length) {
    console.warn(
      `[runner] job ${jobId} intake returned ${intake.images.length} verdicts for ${judged.length} photos; screenshot flags are not mapped to photos`,
    );
    return flagged;
  }
  intake.images.forEach((image, i) => {
    if (image.screenshot === true) {
      flagged.add(judged[i]);
    }
  });
  return flagged;
}

/** Job error when a photo shows more than one product and intake could not
 * tell which one the seller means (docs/phases/PHASE_13.md). Raised before
 * any paid generation; credits held for the pack are released by the
 * failure path. The web app maps it to seller copy. */
export const MULTIPLE_PRODUCTS_MESSAGE =
  "We found more than one product in this photo and could not tell which one you meant, so nothing was charged.";

/** Shot reason when a delivered still holds more than one product after
 * isolation. The web app maps it to seller copy. */
export const SHOT_EXTRA_ITEMS =
  "This image still showed more than one product, so it was left out and not charged.";

/** Photo roles that show several items on purpose, so several products in
 * them are never ambiguous. */
const MULTI_ITEM_ANGLES: ReadonlySet<string> = new Set(["in_the_box"]);

/** The product each photo is for, and the photos where intake could not
 * tell. */
export interface TargetSelection {
  targets: Record<string, ProductTarget>;
  /** Media ids of photos with several products and no single match. */
  ambiguous: string[];
}

/**
 * Picks the product each photo is for from intake's per image products
 * (intake version 3). A photo whose answer lists no products (versions 1
 * and 2) gets no target and is used whole, exactly as before. One product:
 * that one, used whole. Several: the one intake matched to the seller's
 * note, cropped and isolated; none or more than one match makes the photo
 * ambiguous, except for photos that show several items on purpose (the in
 * the box role). When intake's answers cannot be matched to the photos, no
 * target is set, as with the screenshot flags.
 */
export function selectTargets(
  intake: IntakeResult,
  judged: ReadonlyArray<{ mediaId: string; angle?: AngleRole }>,
  jobId: string,
): TargetSelection {
  const selection: TargetSelection = { targets: {}, ambiguous: [] };
  // A photo with several products and no product boxes can never be
  // isolated, so it counts as ambiguous instead of shipping every product.
  const unboxedMulti = (image: IntakeResult["images"][number]) =>
    image.screenshot !== true && (image.products?.length ?? 0) === 0 && image.distinctProducts > 1;
  if (!intake.images.some((image) => (image.products?.length ?? 0) > 0 || unboxedMulti(image))) {
    return selection;
  }
  if (intake.images.length !== judged.length) {
    console.warn(
      `[runner] job ${jobId} intake returned ${intake.images.length} verdicts for ${judged.length} photos; products are not mapped to photos`,
    );
    return selection;
  }
  intake.images.forEach((image, i) => {
    const photo = judged[i];
    const products = image.products ?? [];
    if (unboxedMulti(image) && !(photo.angle && MULTI_ITEM_ANGLES.has(photo.angle))) {
      selection.ambiguous.push(photo.mediaId);
      return;
    }
    if (image.screenshot === true || products.length === 0) {
      return;
    }
    if (products.length === 1) {
      selection.targets[photo.mediaId] = { label: products[0].label, box: null, others: [] };
      return;
    }
    if (photo.angle && MULTI_ITEM_ANGLES.has(photo.angle)) {
      return;
    }
    const matches = products.filter((p) => p.matchesIntent === "yes");
    if (matches.length !== 1) {
      selection.ambiguous.push(photo.mediaId);
      return;
    }
    const [chosen] = matches;
    selection.targets[photo.mediaId] = {
      label: chosen.label,
      box: chosen.box,
      others: products.filter((p) => p !== chosen).map((p) => ({ label: p.label, box: p.box })),
    };
  });
  return selection;
}

/** How many photos the product inventory cuts out at once. Each holds a
 * decoded RGBA copy of the working photo while it is analyzed. */
const INVENTORY_CONCURRENCY = 2;

/** One photo's product inventory: its pieces, how they reconcile with
 * intake, and the product the pack features. */
export interface PhotoInventoryResult {
  record: PhotoInventory;
  decision: InventoryDecision;
  /** True when the rules left the photo undecided in a way the vision
   * picker may settle (needsVisionPick). */
  pickable: boolean;
}

/** Whether the seller wrote anything that could say which product is
 * meant: the note itself, or the intent intake parsed from it. */
export function sellerWroteNote(note: string | null | undefined, intent: SellerIntent | null): boolean {
  return (note ?? "").trim().length > 0 || !!intent?.featureOnly?.trim() || (intent?.exclude.length ?? 0) > 0;
}

/**
 * Picks the product each photo is for from the product inventory first, and
 * from intake alone (selectTargets) for photos without one: the demo
 * generator has no cutout, and a cutout that failed leaves its photo on the
 * intake path, both exactly as before the inventory. The order of the rules
 * is chooseInventoryTarget's (docs/phases/PHASE_13.md, inventory stage).
 *
 * A photo the inventory decided with nothing removed and nothing touching
 * keeps the intake only target, so a photo of one product runs exactly as
 * before. Otherwise its target carries the featured pieces (keep) and the
 * removed ones (others), which the generator isolates on the same cutout.
 */
export function inventorySelection(
  intake: IntakeResult,
  judged: ReadonlyArray<{ mediaId: string; angle?: AngleRole }>,
  cutouts: ReadonlyMap<string, CutoutInventory>,
  note: string | undefined,
  jobId: string,
  picks: ReadonlyMap<string, VisionPick> = new Map(),
): { selection: TargetSelection; photos: PhotoInventoryResult[] } {
  const legacy = selectTargets(intake, judged, jobId);
  const selection: TargetSelection = { targets: { ...legacy.targets }, ambiguous: [...legacy.ambiguous] };
  const photos: PhotoInventoryResult[] = [];
  const mapped = intake.images.length === judged.length;
  const signals = noteSignals(note, intake.sellerIntent ?? null);
  const noteGiven = sellerWroteNote(note, intake.sellerIntent ?? null);
  judged.forEach((photo, i) => {
    const inventory = cutouts.get(photo.mediaId);
    const image = mapped ? intake.images[i] : undefined;
    if (!inventory || image?.screenshot === true) {
      return;
    }
    const products: IntakeProduct[] = image?.products ?? [];
    const choiceInput = {
      objects: inventory.objects,
      products,
      signals,
      multiItem: !!photo.angle && MULTI_ITEM_ANGLES.has(photo.angle),
    };
    let decision = chooseInventoryTarget(choiceInput);
    // The vision tie breaker, when the rules could not decide and the
    // picker answered for this photo. Its answer only counts when
    // visionDecision accepts it; otherwise the photo stays ambiguous.
    let vision: VisionPickRecord | undefined;
    const pick = picks.get(photo.mediaId);
    if (pick && needsVisionPick(decision, inventory.objects.length, noteGiven)) {
      const judgedPick = visionDecision(choiceInput, pick);
      vision = {
        choice: pick.choice,
        confidence: pick.confidence,
        reason: plainReason(pick.reason),
        outcome: judgedPick.outcome,
      };
      if (judgedPick.decision) {
        decision = judgedPick.decision;
      }
    }
    const record = inventoryRecord({
      mediaId: photo.mediaId,
      inventory,
      products,
      distinctProducts: image ? image.distinctProducts : null,
      decision,
      ...(vision ? { vision } : {}),
    });
    photos.push({ record, decision, pickable: needsVisionPick(decision, inventory.objects.length, noteGiven) });
    if (decision.rule === "none") {
      return;
    }
    selection.ambiguous = selection.ambiguous.filter((id) => id !== photo.mediaId);
    if (decision.rule === "ambiguous" || decision.rule === "conflict") {
      delete selection.targets[photo.mediaId];
      selection.ambiguous.push(photo.mediaId);
      return;
    }
    if (decision.removed.length === 0 && !decision.touching) {
      // Nothing to take out: used whole, with the intake target (if any)
      // the photo had before the inventory.
      if (!legacy.targets[photo.mediaId]?.box) {
        return;
      }
      delete selection.targets[photo.mediaId];
      return;
    }
    const match = matchProducts(inventory.objects, products);
    const featured = decision.featured.map((index) => inventory.objects[index]);
    const keep = featured.map((o) => o.box);
    selection.targets[photo.mediaId] = {
      label: [...new Set(featured.map((o) => itemLabel(o, products, match)))].join(" and "),
      box: unionBox(keep),
      others: decision.removed.map((index) => ({
        label: itemLabel(inventory.objects[index], products, match),
        box: inventory.objects[index].box,
      })),
      keep,
      ...(decision.touching ? { touching: true } : {}),
    };
  });
  return { selection, photos };
}

/** The inventory as the compliance report lists it: per photo, numbered in
 * the pack's photo order, each piece's label, color, shape and status. */
export function packInventory(
  photos: readonly PhotoInventoryResult[],
  judged: ReadonlyArray<{ mediaId: string }>,
): PackInventoryPhoto[] {
  return photos.map(({ record }) => ({
    photo: judged.findIndex((j) => j.mediaId === record.mediaId) + 1,
    items: record.items.map((item) => ({
      label: item.label,
      color: item.colorName,
      shape: item.shape,
      status: item.status,
    })),
    ...(record.rule === "vision" && record.vision?.reason
      ? { picked: `${PICKED_BY_VISION}${record.vision.reason}` }
      : {}),
  }));
}

/** How the report and the pack page introduce the vision picker's reason. */
export const PICKED_BY_VISION = "Picked by looking at the photo: ";

/** Everything the vision picker needs for one photo. */
interface PickRequest {
  mediaId: string;
  /** The photo's number in the pack, from 1, for the metering step id. */
  photo: number;
  inventory: CutoutInventory;
  cutout: RawImage;
  products: readonly IntakeProduct[];
}

/** Long side of the original photo sent next to the contact sheet. */
const PICKER_PHOTO_MAX_SIDE = 1024;

/**
 * Asks the target_picker recipe which numbered piece of one photo the
 * seller's note means: a contact sheet of the pieces cut from the photo's
 * inventory cutout (no second cutout call) and the original photo
 * downscaled, with each number's measured facts and the parsed intent as
 * data. The call goes through llmJson, so @curvi/ai meters it and the
 * caller books it on the job. Null when the picker cannot be asked or does
 * not answer in shape; the photo then stays ambiguous.
 */
async function askTargetPicker(
  deps: PipelineDeps,
  recipes: JobRecipes,
  input: GeneratePackInput,
  sellerIntent: SellerIntent | null,
  request: PickRequest,
  booked: <T>(call: Promise<LlmCall<T>>) => Promise<LlmCall<T>>,
): Promise<VisionPick | null> {
  const { inventory, products } = request;
  const order = pickerNumbering(inventory.objects).map((index) => inventory.objects[index]);
  const match = matchProducts(inventory.objects, products);
  const sheet = await renderContactSheet(
    request.cutout,
    order.map((o) => o.pixelBox),
  ).catch((err: unknown) => {
    console.warn(`[runner] job ${input.jobId} could not draw the picker's contact sheet`, errorText(err));
    return null;
  });
  if (!sheet) {
    return null;
  }
  const blocks: unknown[] = [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: sheet.buffer.toString("base64") } },
  ];
  if (deps.loadMedia && isWorkspaceObjectKey(input.workspaceId, request.mediaId)) {
    const bytes = await deps.loadMedia(request.mediaId).catch(() => null);
    const photo = bytes && bytes.length > 0 ? await encodeVisionJpeg(bytes, PICKER_PHOTO_MAX_SIDE).catch(() => null) : null;
    if (photo) {
      blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: photo.toString("base64") } });
    }
  }
  const payload = {
    userDescription: wrapUserDescription(input.userDescription),
    sellerIntent: { featureOnly: sellerIntent?.featureOnly ?? null, exclude: sellerIntent?.exclude ?? [] },
    items: order.map((o, i) => {
      const p = match.productOf[o.index];
      return { number: i + 1, color: o.color.name, shape: o.shape, label: p === null ? null : products[p].label };
    }),
  };
  try {
    const answer = await booked(
      llmJson<VisionPick>(
        deps.ai,
        recipeFor(recipes, "pick"),
        TargetPickAnswer,
        payload,
        { jobId: input.jobId, workspaceId: input.workspaceId, stepId: `pick:${request.photo}` },
        blocks,
        TargetPick,
      ),
    );
    return answer.value;
  } catch (err) {
    console.warn(`[runner] job ${input.jobId} target picker failed; the photo stays ambiguous`, errorText(err));
    return null;
  }
}

/** One photo's inventory and, when the vision picker may need it, the
 * cutout it was read from. */
interface TakenInventory {
  inventory: CutoutInventory;
  cutout: RawImage | null;
}

/**
 * Cuts out and analyzes every camera photo for the product inventory, at
 * most INVENTORY_CONCURRENCY at once, when the generator can cut out. A
 * photo whose cutout fails is left out, so it keeps the intake only path.
 * The provider spend of every cutout lands on the job's COGS through book.
 */
async function takeInventory(
  deps: PipelineDeps,
  input: GeneratePackInput,
  judged: ReadonlyArray<{ mediaId: string }>,
  screenshots: ReadonlySet<string>,
  assertLive: () => Promise<void>,
  book: (micros: number) => void,
): Promise<Map<string, TakenInventory>> {
  const found = new Map<string, TakenInventory>();
  const cut = deps.generator.inventoryCutout?.bind(deps.generator);
  const photos = judged.filter((photo) => !screenshots.has(photo.mediaId));
  if (!cut || photos.length === 0) {
    return found;
  }
  await assertLive();
  await allSettledWithLimit(photos, INVENTORY_CONCURRENCY, async (photo) => {
    try {
      const result = await cut({ jobId: input.jobId, workspaceId: input.workspaceId, mediaId: photo.mediaId });
      book(result.costMicros);
      if (result.cutout) {
        const inventory = analyzeInventory(result.cutout);
        const pieces = inventory.objects.length;
        // The cutout is kept (the generator's cached copy, not a new one)
        // only for photos the vision picker may be asked about.
        const keep = pieces >= PICKER_MIN_PIECES && pieces <= PICKER_MAX_PIECES;
        found.set(photo.mediaId, { inventory, cutout: keep ? result.cutout : null });
      }
    } catch (err) {
      console.warn(`[runner] job ${input.jobId} inventory of one photo failed; it keeps the intake path`, err);
    }
  });
  return found;
}

/** The labels a pack features and removes, for the compliance report: only
 * when a photo's product was isolated from others, since only then was
 * anything removed. */
export function enforcedIntent(
  targets: Record<string, ProductTarget>,
  exclude: readonly string[] = [],
): { featured: string[]; removed: string[] } | null {
  const featured = new Set<string>();
  const removed = new Set<string>(exclude);
  for (const target of Object.values(targets)) {
    if (!target.box) continue;
    featured.add(target.label);
    for (const other of target.others) removed.add(other.label);
  }
  if (featured.size === 0) {
    return null;
  }
  return { featured: [...featured], removed: [...removed] };
}

interface LlmCall<T> {
  value: T | null;
  raw: unknown;
  /** The delivering call plus any billed failed attempts before it. */
  costMicros: number;
}

/** Accepts either a raw JSON object (mock and demo providers) or an
 * Anthropic adapter shaped output with toolUse or text. Plain text answers
 * often wrap JSON in markdown fences or prose, so parsing falls back to the
 * fenced block, then the outermost object literal. */
function extractJsonOutput(output: unknown): unknown {
  if (output && typeof output === "object") {
    const o = output as { toolUse?: { input?: unknown } | null; text?: string | null };
    if (o.toolUse && o.toolUse.input !== undefined) {
      return o.toolUse.input;
    }
    if (typeof o.text === "string") {
      const candidates = [o.text];
      const fenced = o.text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenced) {
        candidates.push(fenced[1]);
      }
      const start = o.text.indexOf("{");
      const end = o.text.lastIndexOf("}");
      if (start >= 0 && end > start) {
        candidates.push(o.text.slice(start, end + 1));
      }
      for (const candidate of candidates) {
        try {
          return JSON.parse(candidate);
        } catch {
          // Try the next candidate.
        }
      }
      return o.text;
    }
  }
  return output;
}

/** The recipe's models as a provider chain, keeping the registered ones.
 * Empty when none is registered (demo mode, or no priced model), and the
 * call then takes the routing table's chain for the recipe key. */
export function recipeChain(ai: Pick<AiDeps, "registry">, recipe: ResolvedRecipe): string[] {
  return recipe.models.map(llmModelProviderName).filter((name) => ai.registry.get(name) !== undefined);
}

async function llmJson<T>(
  ai: AiDeps,
  recipe: ResolvedRecipe,
  schema: { safeParse: (data: unknown) => { success: boolean; data?: T } },
  payload: unknown,
  ctx: { jobId: string; workspaceId: string; stepId: string },
  contentBlocks?: unknown[],
  outputSchema?: z.ZodType,
): Promise<LlmCall<T>> {
  const text = JSON.stringify(payload);
  const content: unknown =
    contentBlocks && contentBlocks.length > 0 ? [...contentBlocks, { type: "text", text }] : text;
  const input: LlmTaskInput = {
    system: recipe.system,
    messages: [{ role: "user", content }],
  };
  if (recipe.maxTokens !== undefined) {
    input.maxTokens = recipe.maxTokens;
  }
  const call = (strict: boolean) => {
    if (outputSchema) {
      // Forced tool call per plan 5.2. With strict tool use the API
      // guarantees the tool input matches the schema (structured outputs
      // docs, checked 2026-09-28); without it the model can emit a shape
      // that fails safeParse, which is how intake failed in production.
      input.tools = [
        {
          name: "emit_result",
          description: "Return the task result as structured data matching the schema exactly.",
          input_schema: strict ? strictToolSchema(outputSchema) : z.toJSONSchema(outputSchema),
          ...(strict ? { strict: true } : {}),
        },
      ];
      input.toolChoice = { type: "tool", name: "emit_result" };
    }
    return callWithFailover<LlmTaskInput, unknown>(
      ai.registry,
      ai.routing,
      ai.meter,
      ai.breakerStore,
      {
        task: recipe.key,
        input,
        workspaceId: ctx.workspaceId,
        jobId: ctx.jobId,
        stepId: ctx.stepId,
      },
      { caps: llmCapsHooks(ai), ...routedCallHooks(ai), ...chainOption(ai, recipe) },
    );
  };

  let result: Awaited<ReturnType<typeof call>>;
  // Billed spend of a strict request the API refused, kept on the books of
  // the retry that follows it.
  let strictFailureMicros = 0;
  try {
    result = await call(Boolean(outputSchema));
  } catch (err) {
    // A 400 on the strict request means the API refused the schema or the
    // strict flag for this model. Retry once as a plain forced tool call, so
    // a schema the grammar compiler rejects never takes packs down.
    if (!outputSchema || !isBadRequest(err)) {
      throw err;
    }
    console.warn(`[runner] ${recipe.key} rejected the strict tool schema, retrying without strict:`, errorText(err));
    strictFailureMicros = failureSpendMicros(err);
    result = await call(false);
  }

  const raw = extractJsonOutput(result.output);
  let parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Some models return nested arrays or objects as JSON strings in tool
    // input. Parse those and validate again before giving up.
    const repaired = parseNestedJsonStrings(raw);
    if (repaired !== raw) {
      parsed = schema.safeParse(repaired);
    }
  }
  if (!parsed.success) {
    // Log where the answer broke the schema (paths and codes only, never the
    // content), so a failure like "Intake response failed schema validation"
    // is diagnosable from the host logs.
    const issues = (parsed as { error?: { issues?: Array<{ path?: unknown[]; code?: string }> } }).error?.issues ?? [];
    const where = issues
      .slice(0, 8)
      .map((i) => `${(i.path ?? []).join(".") || "(root)"}:${i.code ?? "invalid"}`)
      .join(", ");
    const stopReason = (result.output as { stopReason?: unknown } | null)?.stopReason;
    console.warn(
      `[runner] ${recipe.key} output failed schema validation for job ${ctx.jobId} (stop_reason ${String(stopReason ?? "unknown")}): ${where || "no issue detail"}`,
    );
  }
  return {
    value: parsed.success ? (parsed.data as T) : null,
    raw,
    costMicros: result.costMicros + result.billedFailureMicros + strictFailureMicros,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True for a provider 400 (the adapters format HTTP errors as "<provider>
 * responded <status>: <body>"). */
function isBadRequest(err: unknown): boolean {
  return /responded 400\b/.test(errorText(err));
}

/** Copies a value, replacing string leaves that hold a JSON object or array
 * with the parsed value. Returns the input itself when nothing changed. */
export function parseNestedJsonStrings(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return parseNestedJsonStrings(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    const next = value.map(parseNestedJsonStrings);
    return next.some((v, i) => v !== value[i]) ? next : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      next[key] = parseNestedJsonStrings(v);
      changed ||= next[key] !== v;
    }
    return changed ? next : value;
  }
  return value;
}

/** The per call chain option for a recipe, when any of its models is live. */
function chainOption(ai: AiDeps, recipe: ResolvedRecipe): Pick<CallWithFailoverOptions, "chain"> {
  const chain = recipeChain(ai, recipe);
  if (chain.length === 0) {
    return {};
  }
  if (chain.length < recipe.models.length) {
    console.warn(
      `[runner] recipe ${recipe.key} v${recipe.version}: ${recipe.models.length - chain.length} of its models have no live provider and are skipped`,
    );
  }
  return { chain };
}

/**
 * Assigns the job its recipe variants and records them on the job. Never
 * fails the pack: an unreadable recipes table falls back to the seed inside
 * the resolver, and a failure here runs the job on the seed too.
 */
export async function assignRecipes(jobId: string, deps: Pick<PipelineDeps, "recipes" | "store">): Promise<JobRecipes> {
  let recipes: JobRecipes;
  try {
    recipes = deps.recipes ? await deps.recipes.forJob(jobId) : seedJobRecipes();
  } catch (err) {
    console.error(`[runner] could not assign recipes for job ${jobId}; using the seed recipes`, err);
    recipes = seedJobRecipes();
  }
  try {
    await deps.store.saveRecipeVariants?.(jobId, recipeVariantsOf(recipes));
  } catch (err) {
    console.error(`[runner] could not record the recipe variants of job ${jobId}`, err);
  }
  return recipes;
}

/** Verdict from the deterministic checks alone, used when the LLM judge
 * response fails schema validation. */
export function deterministicVerdict(
  pixel: PixelCheckReport,
  fidelity: FidelityReport | null,
): QCVerdict {
  const pass = pixel.pass && (fidelity?.pass ?? true);
  const failing = pixel.checks.filter((c) => !c.pass).map((c) => c.name);
  if (fidelity && !fidelity.pass) {
    failing.push("productFidelity");
  }
  return {
    pass,
    fidelity: pass ? 1 : 0,
    issues: pass ? [] : ["other"],
    repairHint: pass ? "" : `Fix failed checks: ${failing.join(", ")}`.slice(0, 300),
  };
}

const COMPOSITE_METHODS: ReadonlySet<Shot["method"]> = new Set([
  "composite_generate",
  "edit_generate",
]);

interface GenerationSpendResult {
  allowed: boolean;
  reason?: string;
  alert?: boolean;
  alertTotalMicros?: number;
}

/** Reserves a shot generation's actual cost against the per asset, pack and
 * global day caps, releasing the layers already reserved when one blocks. */
async function reserveGenerationSpend(
  caps: SpendCaps,
  shot: Shot,
  ctx: ShotContext,
  costMicros: number,
): Promise<GenerationSpendResult> {
  const isVideo = shot.type.startsWith("video_") || shot.method === "video_generate" || shot.method === "avatar";
  const held: Array<{ key: string; micros: number }> = [];
  const layers = [
    () =>
      isVideo
        ? caps.checkAndReserveVideoAsset(shot.id, costMicros)
        : caps.checkAndReserveImageAsset(shot.id, costMicros),
    () => caps.checkAndReservePack(ctx.jobId, costMicros),
    () => caps.checkAndReserveGlobalDay(costMicros),
  ];
  let alert = false;
  let alertTotalMicros: number | undefined;
  for (const layer of layers) {
    const reservation = await layer();
    if (!reservation.allowed) {
      for (const h of held) {
        await caps.release(h.key, h.micros);
      }
      return { allowed: false, reason: reservation.reason };
    }
    if (reservation.reservedMicros !== 0) {
      held.push({ key: reservation.key, micros: reservation.reservedMicros });
    }
    if (reservation.alert) {
      alert = true;
      alertTotalMicros = reservation.totalMicros;
    }
  }
  return { allowed: true, alert, alertTotalMicros };
}

/** Running provider spend of one shot across all its channel outputs. */
interface ShotSpend {
  micros: number;
}

/** One channel output as runShot produced it. */
interface OutputRun {
  summary: ShotOutputSummary;
  /** The file to deliver, when the output passed. */
  packAsset?: ShotPackAsset;
  /** The accepted generation, kept so other channels can be derived from it. */
  generation?: ShotGeneration;
  /** True when no further output of this shot should be attempted (the job
   * stopped, a cap was reached, or a provider failed outright). */
  stopShot: boolean;
  /** Internal error detail for logs and the job error. */
  failure?: string;
}

function needsReviewSummary(
  specId: string,
  attempts: number,
  usedFallbackProvider: boolean,
  reason: string,
): ShotOutputSummary {
  return {
    specId,
    status: "needs_review",
    attempts,
    usedFallbackProvider,
    verdict: { pass: false, fidelity: 0, issues: ["other"], repairHint: reason.slice(0, 300) },
    pixelPass: false,
    fidelityPass: null,
    measured: { fillPct: null, background: null },
  };
}

/** Background rules whose measured color the compliance badge reports. */
const MEASURED_BACKGROUND_RULES: ReadonlySet<string> = new Set(["solid", "white_or_transparent", "white_preferred"]);

interface CheckedGeneration {
  /** Pixels decoded from the bytes that ship: what every check measured. */
  shipped: RawImage;
  pixel: PixelCheckReport;
  fidelity: FidelityReport | null;
  fidelityInputsMissing: boolean;
  measured: MeasuredCompliance;
}

/**
 * Deterministic QC of one generation against its channel spec, run on the
 * pixels decoded from the encoded file that ships (Update.md 2.3), never on
 * the canvas before encoding. A file that does not decode to the checked
 * canvas fails outright. Rule 3 gate, fail closed: a composite or edit
 * method, or any generation that declares it, must supply a product
 * reference and mask or it never passes.
 */
async function checkGeneration(
  shot: Shot,
  spec: ChannelSpec,
  generation: ShotGeneration,
): Promise<CheckedGeneration> {
  let shipped = generation.image;
  let shippedProblem: string | null = null;
  try {
    const decoded = await decodeToRgba(generation.encoded.buffer);
    if (decoded.width !== generation.image.width || decoded.height !== generation.image.height) {
      shippedProblem = `decodes to ${decoded.width}x${decoded.height}`;
    } else {
      shipped = decoded;
    }
  } catch {
    shippedProblem = "does not decode";
  }

  let pixel = await pixelChecks(shipped, generation.mask, spec, {
    encoded: { bytes: generation.encoded.buffer.length, format: generation.encoded.format },
    edgeMarginPx: QC_EDGE_MARGIN_PX,
  });
  if (shippedProblem) {
    pixel = {
      ...pixel,
      pass: false,
      checks: [
        ...pixel.checks,
        { name: "shippedFile", pass: false, measured: shippedProblem, limit: "decodes to the checked canvas" },
      ],
    };
  }

  let fidelity: FidelityReport | null = null;
  let fidelityInputsMissing = false;
  if (COMPOSITE_METHODS.has(shot.method) || generation.fidelityRequired || generation.productReference) {
    if (generation.productReference && generation.mask) {
      fidelity = await fidelityReport(generation.productReference, shipped, generation.mask, {
        kind: qcKindForSpec(spec),
        ...(generation.fidelityErodePx !== undefined ? { erodePx: generation.fidelityErodePx } : {}),
      });
    } else {
      fidelityInputsMissing = true;
    }
  }

  // Measured values for the compliance badge: the fill the checks saw and
  // the background color the shipped file really has, never the spec value.
  const measured: MeasuredCompliance = {
    fillPct: pixel.fillRatio !== null ? Math.round(pixel.fillRatio * 100) : null,
    background:
      spec.background && MEASURED_BACKGROUND_RULES.has(spec.background.type)
        ? await measureBackgroundRgb(shipped, generation.mask, QC_EDGE_MARGIN_PX)
        : null,
  };
  return { shipped, pixel, fidelity, fidelityInputsMissing, measured };
}

/**
 * Reserves a generation's cost against the caps when the generator did not
 * already reserve before each provider call, and reports the global alert.
 * A generator that reserved per call already reported the alert through the
 * router's onCapAlert, so nothing is read again here. Returns a refusal
 * reason when a cap blocks.
 */
async function settleGenerationSpend(
  shot: Shot,
  ctx: ShotContext,
  deps: PipelineDeps,
  generation: ShotGeneration,
): Promise<string | null> {
  if (deps.ai.caps && !generation.spendReserved && generation.costMicros > 0) {
    const spend = await reserveGenerationSpend(deps.ai.caps, shot, ctx, generation.costMicros);
    if (spend.alert && spend.alertTotalMicros !== undefined) {
      deps.onSpendAlert?.(spend.alertTotalMicros);
    }
    if (!spend.allowed) {
      return `Cost cap reached: ${spend.reason ?? "spend cap"}`;
    }
  }
  return null;
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Generates and QCs one channel output of a shot: generate, check the
 * shipped bytes, ask the qc judge recipe for a verdict (deterministic
 * metrics win over its impression; a judge outage falls back to them), and
 * loop per planRetry: up to 3 attempts with repairHint, one fallback provider
 * attempt, then needs review. Any error ends this output as needs review
 * instead of failing the pack (Update.md 3.3).
 */
async function runOutput(
  shot: Shot,
  specId: string,
  ctx: ShotContext,
  deps: PipelineDeps,
  spent: ShotSpend,
): Promise<OutputRun> {
  const spec = getSpec(specId);
  const target: Shot = { ...shot, channels: [specId] };
  const productTarget = ctx.targets?.[shot.sourceMediaId];
  let attempt = 1;
  let repairHint: string | undefined;
  let useFallbackProvider = false;
  const stop = (reason: string, stopShot: boolean, failure?: string): OutputRun => ({
    summary: needsReviewSummary(specId, attempt, useFallbackProvider, reason),
    stopShot,
    ...(failure !== undefined ? { failure } : {}),
  });

  for (;;) {
    // The heartbeat doubles as a liveness check: once the job was settled
    // elsewhere (the stale reconciler failed it), stop before spending more.
    if ((await deps.store.heartbeat?.(ctx.jobId)) === false) {
      return stop("The job was stopped before this shot finished.", true);
    }
    let generation: ShotGeneration;
    try {
      generation = await deps.generator.generate({
        shot: target,
        attempt,
        repairHint,
        useFallbackProvider,
        jobId: ctx.jobId,
        workspaceId: ctx.workspaceId,
        brandColors: ctx.brandColors,
        ...(ctx.brand ? { brand: ctx.brand } : {}),
        ...(productTarget ? { target: productTarget } : {}),
      });
    } catch (err) {
      // Whatever ended the attempt, the provider spend it made stays on the
      // shot's books (Update.md 5.1), so COGS matches what the caps hold.
      const { error, costMicros } = generationFailure(err);
      spent.micros += costMicros;
      if (error instanceof ShotUnavailableError) {
        return stop(error.message, false);
      }
      if (hasProviderErrorCode(error, "content_blocked")) {
        return stop(SHOT_CONTENT_BLOCKED, false);
      }
      // A provider outage on this shot (for example every image or cutout
      // provider failing) ends this shot only; its siblings carry on.
      console.error(`[runner] shot ${shot.id} for ${specId} failed on attempt ${attempt}`, error);
      return stop(SHOT_PROVIDER_TROUBLE, true, errorDetail(error));
    }
    spent.micros += generation.costMicros;

    // Spend caps on the generation cost (plan 4.4). A cost capped shot goes
    // to needs review and releases its credits, per the 5.6 retry policy.
    const capped = await settleGenerationSpend(shot, ctx, deps, generation);
    if (capped) {
      return stop(capped, true);
    }

    let checked: CheckedGeneration;
    try {
      checked = await checkGeneration(target, spec, generation);
    } catch (err) {
      console.error(`[runner] shot ${shot.id} for ${specId} could not be checked`, err);
      return stop("We could not check this shot, so it needs review.", true, errorDetail(err));
    }
    const { pixel, fidelity, fidelityInputsMissing, measured } = checked;
    const fidelityOk = fidelityInputsMissing ? false : (fidelity?.pass ?? true);
    // A still whose product was isolated from others must hold exactly one
    // product. The mask does not change on a retry, so this ends the output
    // at once, before the judge is paid for.
    const extra = extraItemsFailure(productTarget, generation);
    if (extra) {
      return {
        summary: {
          specId,
          status: "needs_review",
          attempts: attempt,
          usedFallbackProvider: useFallbackProvider,
          verdict: extra,
          pixelPass: pixel.pass,
          fidelityPass: fidelityInputsMissing ? false : fidelity ? fidelity.pass : null,
          measured,
        },
        stopShot: false,
      };
    }

    let verdict: QCVerdict;
    try {
      const judged = await llmJson<QCVerdict>(
        deps.ai,
        recipeFor(ctx.recipes, "qc"),
        QCVerdict,
        {
          shot: { id: shot.id, type: shot.type, scene: shot.scene, channel: specId },
          // The product the image must show and what must not appear, as
          // data; the judge fails a shot showing more with extra_items.
          ...(productTarget ? { sellerIntent: judgeIntent(productTarget, ctx.exclude) } : {}),
          deterministic: {
            pixel: { pass: pixel.pass, checks: pixel.checks },
            fidelity: fidelity
              ? { pass: fidelity.pass, meanDeltaE: fidelity.meanDeltaE, exactByteShare: fidelity.exactByteShare }
              : null,
          },
          attempt,
        },
        { jobId: ctx.jobId, workspaceId: ctx.workspaceId, stepId: `${shot.id}:${specId}:qc:${attempt}` },
        undefined,
        QCVerdict,
      );
      spent.micros += judged.costMicros;
      verdict = judged.value ?? deterministicVerdict(pixel, fidelity);
    } catch (err) {
      spent.micros += failureSpendMicros(err);
      // A cap reached at the judge ends this shot, not the whole pack.
      if (isSpendCapBlock(err)) {
        return stop("Spend cap reached before this shot could be checked.", true);
      }
      // The deterministic checks are the contract; a judge outage must not
      // stop delivery, so their verdict stands alone.
      console.error(`[runner] QC judge unavailable for ${shot.id}; using the deterministic checks`, err);
      verdict = deterministicVerdict(pixel, fidelity);
    }
    // Deterministic metrics are the contract: the judge can fail a shot the
    // checks passed, but can never pass a shot the checks failed.
    const effective: QCVerdict = {
      ...verdict,
      pass: verdict.pass && pixel.pass && fidelityOk,
    };
    if (fidelityInputsMissing) {
      effective.repairHint =
        "Composite generation must return the product reference and mask so the paste back can be proven";
    }
    const summary = (status: ShotOutputSummary["status"]): ShotOutputSummary => ({
      specId,
      status,
      attempts: attempt,
      usedFallbackProvider: useFallbackProvider,
      verdict: effective,
      pixelPass: pixel.pass,
      fidelityPass: fidelityInputsMissing ? false : fidelity ? fidelity.pass : null,
      measured,
    });

    // Spend cap: accepted work stands, but no further attempts are funded.
    let decision = planRetry(attempt, effective);
    if (
      decision.action !== "accept" &&
      deps.assetCostCapMicros !== undefined &&
      spent.micros >= deps.assetCostCapMicros
    ) {
      decision = { action: "needs_review" };
    }
    if (decision.action === "accept") {
      return {
        summary: summary("passed"),
        packAsset: await packAssetFor(shot, specId, ctx, generation),
        generation: { ...generation, image: checked.shipped },
        stopShot: false,
      };
    }
    if (decision.action === "needs_review") {
      return { summary: summary("needs_review"), stopShot: false };
    }
    if (decision.action === "fallback_provider") {
      useFallbackProvider = true;
    }
    attempt = decision.nextAttempt;
    repairHint = decision.repairHint;
  }
}

/** The seller intent the QC judge sees for a shot: the product the image
 * must show and every product or thing that must not appear. */
export function judgeIntent(
  target: ProductTarget,
  exclude: readonly string[] = [],
): { featured: string; exclude: string[] } {
  return {
    featured: target.label,
    exclude: [...new Set([...target.others.map((o) => o.label), ...exclude])],
  };
}

/**
 * The deterministic extra items check (docs/phases/PHASE_13.md item 6): a
 * still whose product was isolated from other products fails when its mask
 * holds more than one significant piece. Photos with a single product (no
 * box) are not checked, so a pair of earrings shot alone still ships.
 */
export function extraItemsFailure(target: ProductTarget | undefined, generation: ShotGeneration): QCVerdict | null {
  if (!target?.box || !generation.mask) {
    return null;
  }
  const pieces = significantComponents(generation.mask).length;
  // A product the inventory found in several parts ships in as many.
  if (pieces <= Math.max(1, target.keep?.length ?? 1)) {
    return null;
  }
  return { pass: false, fidelity: 0, issues: ["extra_items"], repairHint: SHOT_EXTRA_ITEMS };
}

/** The file a passing output delivers: its encoded bytes and mask PNG,
 * decoded again only when the packager checks it. */
async function packAssetFor(
  shot: Shot,
  specId: string,
  ctx: ShotContext,
  generation: ShotGeneration,
): Promise<ShotPackAsset> {
  const maskPng = generation.mask ? await encodeMaskPng(generation.mask) : undefined;
  return {
    specId,
    buffer: generation.encoded.buffer,
    format: generation.encoded.format,
    ...(maskPng ? { maskPng } : {}),
    loadPixels: lazyPackPixels(maskPng),
    sku: ctx.sku,
    seoSlug: ctx.seoSlug,
    edgeMarginPx: QC_EDGE_MARGIN_PX,
    ref: shot.id,
    digitalSource: digitalSourceFor(shot.method, ctx.mode),
  };
}

/**
 * Another channel's output of an accepted composite, derived without a new
 * scene (the generator's deriveForSpec) and checked by the deterministic
 * checks alone: it is the accepted image re-framed, so there is nothing new
 * for the judge to see and no retry would change it.
 */
async function deriveOutput(
  shot: Shot,
  specId: string,
  from: ShotGeneration,
  ctx: ShotContext,
  deps: PipelineDeps,
  spent: ShotSpend,
): Promise<OutputRun> {
  const spec = getSpec(specId);
  const target: Shot = { ...shot, channels: [specId] };
  const stop = (reason: string, stopShot: boolean, failure?: string): OutputRun => ({
    summary: needsReviewSummary(specId, 1, false, reason),
    stopShot,
    ...(failure !== undefined ? { failure } : {}),
  });
  if ((await deps.store.heartbeat?.(ctx.jobId)) === false) {
    return stop("The job was stopped before this shot finished.", true);
  }
  const productTarget = ctx.targets?.[shot.sourceMediaId];
  const args: ShotGenerateArgs = {
    shot: target,
    attempt: 1,
    useFallbackProvider: false,
    jobId: ctx.jobId,
    workspaceId: ctx.workspaceId,
    brandColors: ctx.brandColors,
    ...(ctx.brand ? { brand: ctx.brand } : {}),
    ...(productTarget ? { target: productTarget } : {}),
  };
  let generation: ShotGeneration;
  try {
    generation = deps.generator.deriveForSpec
      ? await deps.generator.deriveForSpec(args, from, specId)
      : await deps.generator.generate(args);
  } catch (err) {
    const { error, costMicros } = generationFailure(err);
    spent.micros += costMicros;
    if (error instanceof ShotUnavailableError) {
      return stop(error.message, false);
    }
    console.error(`[runner] shot ${shot.id} could not be prepared for ${specId}`, error);
    return stop("This image could not be prepared for this channel, so it needs review.", false, errorDetail(error));
  }
  spent.micros += generation.costMicros;
  const capped = await settleGenerationSpend(shot, ctx, deps, generation);
  if (capped) {
    return stop(capped, true);
  }
  let checked: CheckedGeneration;
  try {
    checked = await checkGeneration(target, spec, generation);
  } catch (err) {
    console.error(`[runner] shot ${shot.id} for ${specId} could not be checked`, err);
    return stop("We could not check this shot, so it needs review.", false, errorDetail(err));
  }
  const { pixel, fidelity, fidelityInputsMissing, measured } = checked;
  const verdict = extraItemsFailure(productTarget, generation) ?? deterministicVerdict(pixel, fidelity);
  const pass = verdict.pass && !fidelityInputsMissing;
  const summary: ShotOutputSummary = {
    specId,
    status: pass ? "passed" : "needs_review",
    attempts: 1,
    usedFallbackProvider: false,
    verdict: { ...verdict, pass },
    pixelPass: pixel.pass,
    fidelityPass: fidelityInputsMissing ? false : fidelity ? fidelity.pass : null,
    measured,
  };
  return pass
    ? { summary, packAsset: await packAssetFor(shot, specId, ctx, generation), stopShot: false }
    : { summary, stopShot: false };
}

/** The shot's channel specs, known and deduplicated, in plan order. */
export function shotTargetSpecs(shot: Shot): string[] {
  return [...new Set(shot.channels.filter((c) => hasSpec(c)))];
}

/** The spec a multi channel composite is generated at: the largest canvas,
 * so every other channel is derived by scaling down or re-encoding. */
export function primarySpecOf(specIds: readonly string[]): string {
  let best = specIds[0];
  let bestArea = -1;
  for (const id of specIds) {
    const { width, height } = canvasSizeFor(getSpec(id));
    if (width * height > bestArea) {
      best = id;
      bestArea = width * height;
    }
  }
  return best;
}

/**
 * Generate and QC one shot for every channel it targets (Update.md 2.11).
 * Still methods render each channel from the product cutout (cheap once the
 * cutout is cached); composites are generated once at the primary channel
 * and every other channel is derived from that accepted image, so the scene
 * is paid for once. Each channel output gets its own QC and its own file.
 * The shot passes, and is charged once, when any output passes. Any error
 * ends the affected output as needs review; it never fails the pack.
 */
export async function runShot(
  shot: Shot,
  ctx: ShotContext,
  pipelineDeps: PipelineDeps,
): Promise<ShotOutcome> {
  // A fan out subtask builds its own store, so the shot binds its run here.
  const deps: PipelineDeps = { ...pipelineDeps, store: storeForRun(pipelineDeps.store, ctx.runKey) };
  const targets = shotTargetSpecs(shot);
  const spent: ShotSpend = { micros: 0 };
  const runs: OutputRun[] = [];

  if (targets.length > 0 && COMPOSITE_METHODS.has(shot.method)) {
    const primary = primarySpecOf(targets);
    const first = await runOutput(shot, primary, ctx, deps, spent);
    runs.push(first);
    if (first.generation && !first.stopShot) {
      for (const specId of targets.filter((s) => s !== primary)) {
        const derived = await deriveOutput(shot, specId, first.generation, ctx, deps, spent);
        runs.push(derived);
        if (derived.stopShot) break;
      }
    }
  } else {
    for (const specId of targets) {
      const run = await runOutput(shot, specId, ctx, deps, spent);
      runs.push(run);
      if (run.stopShot) break;
    }
  }

  const passedRuns = runs.filter((r) => r.summary.status === "passed");
  const representative =
    passedRuns[0]?.summary ??
    runs[0]?.summary ??
    needsReviewSummary(shot.channels[0] ?? "", 1, false, "This shot has no channel to size it for, so it needs review.");
  const failure = runs.find((r) => r.failure !== undefined)?.failure;
  const outcome: ShotOutcome = {
    shotId: shot.id,
    shotType: shot.type,
    specId: representative.specId,
    credits: shot.credits,
    status: passedRuns.length > 0 ? "passed" : "needs_review",
    attempts: representative.attempts,
    usedFallbackProvider: runs.some((r) => r.summary.usedFallbackProvider),
    costMicros: spent.micros,
    verdict: representative.verdict,
    pixelPass: representative.pixelPass,
    fidelityPass: representative.fidelityPass,
    digitalSource: digitalSourceFor(shot.method, ctx.mode),
    measured: representative.measured,
    outputs: runs.map((r) => r.summary),
    ...(passedRuns.length > 0 ? { packAssets: passedRuns.map((r) => r.packAsset as ShotPackAsset) } : {}),
    ...(passedRuns.length === 0 && failure !== undefined ? { failure } : {}),
  };
  await deps.store.saveAsset(toStoredAsset(outcome, ctx, shot));
  return outcome;
}

/**
 * A needs review outcome for a shot that never produced one of its own, for
 * example a fan out subtask that crashed after its retries. Its credits are
 * released like any other shot that needs review.
 */
export function shotFailureOutcome(
  shot: Shot,
  ctx: ShotContext,
  reason: string = SHOT_PROVIDER_TROUBLE,
  failure?: string,
): ShotOutcome {
  const summary = needsReviewSummary(shot.channels[0] ?? "", 1, false, reason);
  return {
    shotId: shot.id,
    shotType: shot.type,
    specId: summary.specId,
    credits: shot.credits,
    status: "needs_review",
    attempts: 1,
    usedFallbackProvider: false,
    costMicros: 0,
    verdict: summary.verdict,
    pixelPass: false,
    fidelityPass: null,
    digitalSource: digitalSourceFor(shot.method, ctx.mode),
    measured: summary.measured,
    outputs: [summary],
    ...(failure !== undefined ? { failure } : {}),
  };
}

/** Records a failed shot on the board (best effort) and returns its outcome. */
export async function recordShotFailure(
  store: JobStore,
  shot: Shot,
  ctx: ShotContext,
  err: unknown,
): Promise<ShotOutcome> {
  console.error(`[runner] shot ${shot.id} failed outside its QC loop`, err);
  const outcome = shotFailureOutcome(shot, ctx, SHOT_PROVIDER_TROUBLE, errorDetail(err));
  try {
    await storeForRun(store, ctx.runKey).saveAsset(toStoredAsset(outcome, ctx, shot));
  } catch (saveErr) {
    console.error(`[runner] could not record failed shot ${shot.id}`, saveErr);
  }
  return outcome;
}

function toStoredAsset(outcome: ShotOutcome, ctx: ShotContext, shot: Shot): StoredAsset {
  const file = outcome.packAssets?.find((a) => a.specId === outcome.specId) ?? outcome.packAssets?.[0];
  return {
    jobId: ctx.jobId,
    workspaceId: ctx.workspaceId,
    shotId: outcome.shotId,
    shotType: outcome.shotType,
    specId: outcome.specId,
    status: outcome.status,
    attempts: outcome.attempts,
    credits: outcome.credits,
    costMicros: outcome.costMicros,
    verdict: outcome.verdict,
    measured: outcome.measured,
    encoded: file ? { buffer: file.buffer, format: file.format ?? "png" } : undefined,
    shot,
  };
}

/** Wraps seller text in the untrusted data tags the seeded system prompts
 * reference (plan 4.5.3): user text is data, never instructions. The text is
 * escaped first, so it can never close the tag and speak as trusted prompt
 * text (Update.md 4.5). */
export function wrapUserDescription(description: string | undefined | null): string | null {
  if (!description || description.length === 0) {
    return null;
  }
  const escaped = description.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<user_description>${escaped}</user_description>`;
}

/** Moderation gate (plan 4.5.2): intake flags and analyzer compliance flags
 * that block generation outright. Returns the reasons, empty when clean.
 *
 * Brands and logos are always allowed (docs/phases/PHASE_14.md workstream
 * 2): possible_counterfeit stays in the ProductProfile enum so stored
 * answers still parse, but it never blocks, and nothing here looks at a
 * brand or a logo. Only nudity or adult content, weapons, drugs, prohibited
 * goods and a person as the main subject stop a pack. */
export function moderationBlockReasons(
  intake: IntakeResult,
  profile: ProductProfile | null,
): string[] {
  const reasons = new Set<string>();
  for (const image of intake.images) {
    if (image.flags.nudity) reasons.add("nudity");
    if (image.flags.weapons) reasons.add("weapons");
    if (image.flags.drugs) reasons.add("drugs");
    if (image.flags.prohibited) reasons.add("prohibited goods");
    if (image.flags.realPersonMainSubject) reasons.add("a real person as the main subject");
  }
  for (const flag of profile?.complianceFlags ?? []) {
    if (flag === "prohibited") reasons.add("prohibited goods");
    else if (flag === "adult") reasons.add("adult content");
    else if (flag === "weapon") reasons.add("weapons");
    // "none", "possible_counterfeit" and the claim flags never block.
  }
  return [...reasons];
}

/** Stored job error when moderation stops a pack. There is no review
 * queue: the web app (apps/web job-copy.ts) matches the prefix and the
 * first category to plain copy that names it and asks for another photo. */
export const MODERATION_BLOCKED_PREFIX = "Moderation stopped this pack, nothing was charged. The upload shows";

export function moderationBlockedMessage(reasons: readonly string[]): string {
  return `${MODERATION_BLOCKED_PREFIX} ${reasons.join(", ")}`;
}

/** Stored job error when intake finds no product for sale. The labels
 * intake gave, and whether the photo was blurry, ride along after fixed
 * markers so the web app can say what was seen (PHASE_14 item 3.3). */
export const NO_SELLABLE_PRODUCT_MESSAGE = "Intake found no sellable product in the uploaded images";

export function noSellableProductMessage(verdicts: IntakeResult["images"]): string {
  const labels = new Set<string>();
  for (const verdict of verdicts) {
    for (const product of verdict.products ?? []) labels.add(product.label.trim());
    for (const box of verdict.boundingBoxes ?? []) labels.add(box.label.trim());
  }
  labels.delete("");
  let message = NO_SELLABLE_PRODUCT_MESSAGE;
  if (verdicts.length > 0 && verdicts.every((verdict) => !verdict.sharpEnough)) {
    message += ". Not sharp";
  }
  if (labels.size > 0) {
    message += `. Intake saw: ${[...labels].slice(0, 4).join("; ")}`;
  }
  return message;
}

/** Concept packs never target marketplace channels (plan 2.7); the web
 * estimate leaves the same channels out, with the same helper. */
export { isMarketplaceChannel };

/** Channel families of the selected channels ("amazon.main" and "amazon"
 * both select the amazon family). Decides which zips a pack gets and which
 * families an LLM plan may name at all. */
export function selectedFamilies(channels: readonly string[]): Set<string> {
  return new Set(channels.map((c) => channelOf(c)));
}

/**
 * True when the seller picked this channel spec (Update.md 2.11). The one
 * selection rule lives in @curvi/specs, so the planner, this runner and the
 * web estimate and hold always agree on what a pack makes.
 */
export { isSpecSelected };

/**
 * Credits for a shot, from the creditCosts seed by method (CLAUDE.md rule 2),
 * never from what a planner claims. Generative video is priced per second of
 * the duration its type names (video_hero_6s is 6 seconds); video without a
 * duration is the templated video price.
 */
export function creditsForShot(shot: Pick<Shot, "type" | "method">): number {
  switch (shot.method) {
    case "deterministic":
    case "template":
      return creditCosts.deterministic;
    case "composite_generate":
    case "edit_generate":
      return creditCosts.generativeStill;
    case "avatar":
      return creditCosts.ugcAvatarAd;
    case "video_generate": {
      const seconds = /_(\d+)s$/.exec(shot.type)?.[1];
      return seconds ? creditCosts.generativeVideoPerSecondLite * Number(seconds) : creditCosts.templatedVideo;
    }
  }
}

/** What an LLM shot plan is checked against. */
export interface LlmPlanRules {
  /** The job's credit reservation. */
  budget: number;
  /** Media ids of the photos this job uploaded. */
  mediaIds: readonly string[];
  /** The channels the pack may target (concept mode already removed the
   * marketplace ones). */
  channels: readonly string[];
  mode: "listing" | "concept";
  /** True when a usable front photo exists, so Amazon needs its main image. */
  requireAmazonMain: boolean;
  /** Shot methods no live provider delivers yet (video, avatar). Their shots
   * are dropped before every other check, so a plan that follows the recipe
   * and includes them is neither rejected nor trimmed against a stills only
   * budget (Update.md 1.7). */
  excludeMethods?: ReadonlyArray<Shot["method"]>;
  /** Picked specs the plan must give a file: the specs the deterministic
   * planner delivers for this pack at this budget (coveredSpecs). A plan
   * that leaves one of them out is rejected, so the fallback makes it. */
  requiredSpecs?: readonly string[];
}

export type LlmPlanCheck = { ok: true; shotList: ShotList } | { ok: false; reason: string };

/**
 * An LLM shot list is used only when it validates against the schema, every
 * shot id is unique, every shot claims a positive cost (the real price is
 * then taken from the seed), every shot draws from one of this job's photos, every
 * channel is a known spec inside the selected channel families (and never a
 * marketplace spec in concept mode), at most one shot targets amazon.main and
 * it is the deterministic amazon_main, no channel spec gets more shots than
 * it takes files (a ninth amazon.secondary), Amazon gets its main image when
 * amazon.main is selected and a usable front photo exists, every required
 * spec (a picked spec the deterministic planner can deliver, such as
 * walmart.main next to Amazon) has a shot, and the plan fits the budget once
 * every shot is repriced from the seed (Update.md 1.7, 2.10, 2.11, 2.12).
 * Shots of an excluded method are dropped first, and each shot keeps
 * only the channel specs the seller picked (a shot left with none is
 * skipped), so the limits and the budget are checked against what would
 * really run. Otherwise the deterministic planner runs, and the reason is
 * reported.
 */
/** Shot types only the pixel pipeline makes, never an image model. */
export const PACKSHOT_TYPES: ReadonlySet<Shot["type"]> = new Set<Shot["type"]>([
  "amazon_main",
  "alt_angle_white",
  "cutout_png",
  "sweep_gray",
  "sweep_brand",
]);

export function validateLlmShotList(raw: unknown, rules: LlmPlanRules): LlmPlanCheck {
  const parsed = ShotList.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "the plan did not match the shot list schema" };
  }
  const excluded = new Set(rules.excludeMethods ?? []);
  const skipped: ShotList["skipped"] = [...parsed.data.skipped];
  const shots: Shot[] = [];
  // Packshots (white main, alternate angles, the transparent cutout and the
  // plain sweeps) are always made from the real photo by the pixel
  // pipeline. An image model asked for a "cutout" draws a studio and a fake
  // checkerboard, so the planner's method is overruled for these types.
  const packshotsFixed = parsed.data.shots.map((shot) =>
    PACKSHOT_TYPES.has(shot.type) && shot.method !== "deterministic"
      ? { ...shot, method: "deterministic" as const, stylePreset: "none", scene: undefined }
      : shot,
  );
  for (const shot of packshotsFixed) {
    if (excluded.has(shot.method)) {
      skipped.push({ type: shot.type, reason: PROVIDER_NOT_ENABLED });
    } else {
      shots.push(shot);
    }
  }
  const media = new Set(rules.mediaIds);
  const families = selectedFamilies(rules.channels);
  const ids = new Set<string>();
  for (const shot of shots) {
    if (ids.has(shot.id)) {
      return { ok: false, reason: `shot id ${shot.id} is used twice` };
    }
    ids.add(shot.id);
    if (!media.has(shot.sourceMediaId)) {
      return { ok: false, reason: `shot ${shot.id} draws from a photo this job did not upload` };
    }
    // Prices come from the seed below, but a plan that claims a shot costs
    // nothing is malformed (it would settle as a zero charge after delivery).
    if (!(Number.isFinite(shot.credits) && shot.credits > 0)) {
      return { ok: false, reason: `shot ${shot.id} claims no credit cost` };
    }
    if (shot.channels.length === 0) {
      return { ok: false, reason: `shot ${shot.id} targets no channel` };
    }
    for (const channel of shot.channels) {
      if (!hasSpec(channel)) {
        return { ok: false, reason: `shot ${shot.id} targets unknown channel ${channel}` };
      }
      if (!families.has(channelOf(channel))) {
        return { ok: false, reason: `shot ${shot.id} targets ${channel}, outside the selected channels` };
      }
      if (rules.mode === "concept" && isMarketplaceSpec(channel)) {
        return { ok: false, reason: `shot ${shot.id} targets marketplace channel ${channel} in a concept pack` };
      }
    }
  }
  // Only the specs the seller picked are generated and charged.
  const narrowed: Shot[] = [];
  for (const shot of shots) {
    const kept = [...new Set(shot.channels.filter((c) => isSpecSelected(rules.channels, c)))];
    if (kept.length === 0) {
      skipped.push({ type: shot.type, reason: CHANNEL_NOT_SELECTED });
      continue;
    }
    narrowed.push(kept.length === shot.channels.length ? shot : { ...shot, channels: kept });
  }
  if (narrowed.length === 0) {
    return { ok: false, reason: "the plan has no shot for the selected channels" };
  }
  const mains = narrowed.filter((s) => s.channels.includes("amazon.main"));
  if (mains.length > 1) {
    return { ok: false, reason: "more than one shot targets amazon.main" };
  }
  if (mains.some((s) => s.type !== "amazon_main" || s.method !== "deterministic")) {
    return { ok: false, reason: "amazon.main must be the deterministic amazon_main shot" };
  }
  // The packager delivers at most channelFileLimit files per spec; a plan
  // over it would hold and generate shots that can never ship.
  const [violation] = channelLimitViolations(narrowed);
  if (violation) {
    return {
      ok: false,
      reason: `${violation.count} shots target ${violation.specId}, which takes at most ${violation.limit}`,
    };
  }
  if (
    rules.mode === "listing" &&
    rules.requireAmazonMain &&
    isSpecSelected(rules.channels, "amazon.main") &&
    mains.length === 0
  ) {
    return { ok: false, reason: "Amazon is selected but the plan has no amazon_main shot" };
  }
  const planned = coveredSpecs(narrowed);
  const uncovered = (rules.requiredSpecs ?? []).filter((specId) => !planned.has(specId));
  if (uncovered.length > 0) {
    return { ok: false, reason: `the plan has no shot for ${uncovered.join(", ")}` };
  }
  const repriced = narrowed.map((s) => ({ ...s, credits: creditsForShot(s) }));
  const total = repriced.reduce((sum, s) => sum + s.credits, 0);
  if (total > rules.budget) {
    return { ok: false, reason: `the plan needs ${total} credits and the budget is ${rules.budget}` };
  }
  return { ok: true, shotList: { shots: repriced, skipped } };
}

/** The channel specs a shot list gives at least one file. */
export function coveredSpecs(shots: readonly Shot[]): Set<string> {
  return new Set(shots.flatMap((shot) => shot.channels));
}

export interface FitOptions {
  channels: readonly string[];
  mode: "listing" | "concept";
  budget: number;
  profile: ProductProfile;
  primaryMediaId?: string;
  /** Shot methods no live provider delivers yet; their shots are skipped as
   * "provider not enabled" before the budget trim, so they never take room
   * a deliverable shot could use. */
  excludeMethods?: ReadonlyArray<Shot["method"]>;
}

const GOOGLE_MAIN_SPEC = "google.merchant.main";
/** ShotList schema cap. */
const MAX_PLAN_SHOTS = 40;

/**
 * Fits a plan to what the seller selected and what can ship (Update.md 1.7,
 * 2.10, 2.11), in this order, so every limit and the budget see only shots
 * that would really run:
 * 1. shots of an excluded method are skipped ("provider not enabled");
 * 2. every shot keeps only the channel specs the seller picked (a spec id
 *    selects only itself, a family every spec in it; never a marketplace
 *    spec in concept mode), and a shot left with none is skipped, so
 *    unselected crops, banners and heroes cost nothing;
 * 3. when google.merchant.main is picked its slot is filled: the white main
 *    image also ships to Google when there is one, otherwise a white front
 *    shot is added;
 * 4. no spec gets more shots than it takes files (capShotsPerChannel);
 * 5. the plan is trimmed to the budget, lowest priority first;
 * 6. shot ids are made unique.
 * Shots aimed at any selected marketplace listing spec (etsy.listing,
 * ebay.listing, walmart.main, tiktokshop.main) or at pinterest.pin are kept
 * and packed like every other channel.
 */
export function fitShotsToChannels(plan: ShotList, opts: FitOptions): ShotList {
  const excluded = new Set(opts.excludeMethods ?? []);
  const skipped = [...plan.skipped];
  let shots: Shot[] = [];
  for (const shot of plan.shots) {
    if (excluded.has(shot.method)) {
      skipped.push({ type: shot.type, reason: PROVIDER_NOT_ENABLED });
      continue;
    }
    const kept = [
      ...new Set(
        shot.channels.filter(
          (c) => isSpecSelected(opts.channels, c) && !(opts.mode === "concept" && isMarketplaceSpec(c)),
        ),
      ),
    ];
    if (kept.length === 0) {
      skipped.push({ type: shot.type, reason: CHANNEL_NOT_SELECTED });
      continue;
    }
    shots.push({ ...shot, channels: kept });
  }

  if (
    opts.mode === "listing" &&
    isSpecSelected(opts.channels, GOOGLE_MAIN_SPEC) &&
    !shots.some((s) => s.channels.includes(GOOGLE_MAIN_SPEC))
  ) {
    const whiteMain = shots.find((s) => s.type === "amazon_main" && s.method === "deterministic");
    const frontUsable =
      opts.profile.imageQuality.usableForMain && opts.profile.photographedAngles.includes("front");
    if (whiteMain) {
      whiteMain.channels = [...whiteMain.channels, GOOGLE_MAIN_SPEC];
    } else if (!frontUsable || !opts.primaryMediaId) {
      skipped.push({ type: "google_main", reason: "needs photo" });
    } else {
      // Priority 1, so the budget trim below keeps it over any extra.
      shots.unshift({
        id: "s00_google_main",
        type: "alt_angle_white",
        sourceMediaId: opts.primaryMediaId,
        method: "deterministic",
        channels: [GOOGLE_MAIN_SPEC],
        stylePreset: "none",
        credits: creditsForShot({ type: "alt_angle_white", method: "deterministic" }),
        priority: 1,
      });
    }
  }

  shots = capShotsPerChannel(shots, skipped);
  shots = trimShotsToBudget(shots, opts.budget, skipped);

  // Shot ids key the ledger charges; a duplicate would hold credits forever.
  const seen = new Set<string>();
  for (const shot of shots) {
    let id = shot.id;
    for (let n = 2; seen.has(id); n++) {
      id = `${shot.id}_${n}`;
    }
    seen.add(id);
    shot.id = id;
  }
  return { shots, skipped };
}

/**
 * Keeps the plan within the credit budget and the schema's shot cap: the
 * planner's rule 6 (trimToBudget, shared with planShots), applied after the
 * plan was fitted to the selection. Every shot left here targets a picked
 * spec, and the trim keeps a file for each picked spec it can afford before
 * it keeps extras, dropping the lowest priority shot first (the largest
 * number) and, among ties, the most expensive one. Past the shot cap the
 * lowest priority shots go.
 */
export function trimShotsToBudget(shots: readonly Shot[], budget: number, skipped: ShotList["skipped"]): Shot[] {
  const kept = trimToBudget(shots, budget, skipped);
  while (kept.length > MAX_PLAN_SHOTS) {
    let dropIdx = 0;
    for (let i = 1; i < kept.length; i++) {
      const a = kept[i];
      const b = kept[dropIdx];
      if (a.priority > b.priority || (a.priority === b.priority && a.credits > b.credits)) {
        dropIdx = i;
      }
    }
    const [dropped] = kept.splice(dropIdx, 1);
    skipped.push({ type: dropped.type, reason: "shot cap" });
  }
  return kept;
}

/** Plan options as the runner sends them: PlanOptions plus the shot methods
 * no live provider delivers yet, so the planner (and the LLM planner, which
 * sees these options) leaves them out before it trims to the budget. */
/** The planner options the runner passes; PlanOptions carries undeliverableMethods itself. */
export type RunnerPlanOptions = PlanOptions;

/**
 * The deterministic planner's plan for a pack. planShots proposes every shot
 * the product supports without a budget, so its own trim never keeps an
 * unselected crop or banner over a shot the seller picked; fitShotsToChannels
 * then narrows the plan to the selection and trims it to the real budget.
 */
export function deterministicPlan(profile: ProductProfile, options: RunnerPlanOptions, fit: FitOptions): ShotList {
  const everything: RunnerPlanOptions = { ...options, creditBudget: Number.MAX_SAFE_INTEGER };
  return fitShotsToChannels(planShots(profile, everything), fit);
}

/** The seller's printable lines for the in_the_box and comparison images. */
export interface SellerCopy {
  boxContents: string[];
  comparisonFacts: string[];
}

export function sellerCopyOf(input: Pick<GeneratePackInput, "boxContents" | "comparisonFacts">): SellerCopy {
  return {
    boxContents: printableSellerLines(input.boxContents),
    comparisonFacts: printableSellerLines(input.comparisonFacts),
  };
}

/**
 * Puts the seller's own lines on the in_the_box and comparison shots of the
 * chosen plan, whichever planner made it, so these images print exactly what
 * the seller typed and never a model's wording. A plan that has either shot
 * without the seller's lines for it (an LLM plan that invented one) loses
 * that shot to skipped with the planner's reason, so nothing is generated
 * or charged for it.
 */
export function withSellerCopy(plan: ShotList, copy: SellerCopy): ShotList {
  const skipped = [...plan.skipped];
  const shots: Shot[] = [];
  for (const shot of plan.shots) {
    const lines =
      shot.type === "in_the_box" ? copy.boxContents : shot.type === "comparison" ? copy.comparisonFacts : null;
    if (lines === null) {
      shots.push(shot);
    } else if (lines.length > 0) {
      shots.push({ ...shot, callouts: [...lines] });
    } else {
      skipped.push({
        type: shot.type,
        reason: shot.type === "in_the_box" ? NO_BOX_CONTENTS_REASON : NO_COMPARISON_FACTS_REASON,
      });
    }
  }
  return { shots, skipped };
}

/** Job error when neither shot planner produced a plan. Plain copy the
 * board shows; credits held for the pack are released by the failure path. */
export const PLAN_FAILED_MESSAGE = "We could not plan the shots for this product, so nothing was charged.";

/** Job error when no shot in the pack passed. Plain copy the board shows. */
function noShotPassedMessage(outcomes: readonly ShotOutcome[]): string {
  if (outcomes.length === 0) {
    return "No shots could be planned for the channels you picked, so nothing was charged.";
  }
  const failures = outcomes.map((o) => o.failure).filter((f): f is string => f !== undefined);
  if (failures.length === outcomes.length) {
    return `None of the shots in this pack could be made, so nothing was charged. The first error was: ${failures[0]}`;
  }
  return "None of the shots in this pack passed its checks, so nothing was charged. Each shot is marked for review.";
}

export async function runGeneratePack(
  input: GeneratePackInput,
  pipelineDeps: PipelineDeps,
): Promise<GeneratePackSummary> {
  // Every store call of this run, its shots included, checks the run's key.
  const deps: PipelineDeps = { ...pipelineDeps, store: storeForRun(pipelineDeps.store, input.runKey) };
  const { store, clock } = deps;
  const ledger = new JobLedgerPlan();
  let state: JobState = "queued";
  let costMicros = 0;
  let plannerSource: GeneratePackSummary["plannerSource"] = null;
  let planRejection: string | undefined;
  let plannedShots = 0;
  let skipped: Array<{ type: string; reason: string }> = [];
  let passed = 0;
  let needsReview = 0;
  let pack: StoredPack | null = null;
  let settled = false;

  const applyLedger = async (action: LedgerAction | null): Promise<void> => {
    if (!action) {
      return;
    }
    await store.appendLedger({
      ...action,
      jobId: input.jobId,
      workspaceId: input.workspaceId,
      at: clock.now(),
    });
  };

  // Every state write doubles as a liveness check: a job the stale run
  // reconciler already failed stops here instead of spending further.
  const advance = async (next: JobState, meta?: Record<string, unknown>): Promise<void> => {
    const applied = await store.setJobState(input.jobId, next, meta);
    if (applied === false) {
      throw new JobAbandonedError(input.jobId);
    }
    state = next;
  };
  // Liveness between state writes: the heartbeat returns false once the job
  // was settled elsewhere, for example by the web app's inline run cap.
  const assertLive = async (): Promise<void> => {
    if ((await store.heartbeat?.(input.jobId)) === false) {
      throw new JobAbandonedError(input.jobId);
    }
  };

  const summarize = (outcome: "done" | "failed", error?: string): GeneratePackSummary => ({
    jobId: input.jobId,
    state: outcome,
    reservedCredits: ledger.reserved,
    chargedCredits: ledger.charged,
    releasedCredits: ledger.released,
    passed,
    needsReview,
    plannedShots,
    skipped,
    plannerSource,
    ...(planRejection !== undefined ? { planRejection } : {}),
    costMicros,
    pack,
    ...(error !== undefined ? { error } : {}),
  });

  // Every LLM call's spend lands on the job's COGS, including the billed
  // attempts of a chain that failed, before the failure propagates.
  const bookedLlm = async <T>(call: Promise<LlmCall<T>>): Promise<LlmCall<T>> => {
    try {
      const result = await call;
      costMicros += result.costMicros;
      return result;
    } catch (err) {
      costMicros += failureSpendMicros(err);
      throw err;
    }
  };

  if ((await store.setJobState(input.jobId, state)) === false) {
    // Already terminal before this run started (for example reconciled while
    // it waited in the queue); its reservation was settled there.
    return summarize("failed", new JobAbandonedError(input.jobId).message);
  }
  await applyLedger(ledger.reserveOnQueue(input.creditBudget));
  const recipes = await assignRecipes(input.jobId, deps);

  try {
    // Intake and analyze, with the uploaded photos as vision input when a
    // media loader is wired.
    await advance(transition(state, "start_analysis"));
    // Intake sees every photo, and its text lists exactly the photos it was
    // shown, so its per image screenshot verdicts map one to one onto them.
    const shown = await visionPhotos(deps, input.images, input.workspaceId, INTAKE_PHOTO_LIMIT);
    const photos = shown.map((photo) => photo.block);
    const judgedImages = intakeImages(input.images, shown);
    const intake = await bookedLlm(
      llmJson<IntakeResult>(
        deps.ai,
        recipeFor(recipes, "intake"),
        IntakeResult,
        { images: judgedImages, userDescription: wrapUserDescription(input.userDescription) },
        { jobId: input.jobId, workspaceId: input.workspaceId, stepId: "intake" },
        photos,
        IntakeToolResult,
      ),
    );
    if (!intake.value) {
      throw new Error("Intake response failed schema validation");
    }
    // The seller's note as structured intent (intake version 3), kept on
    // the job so follow ups and retries keep it. Data only: never a reason
    // to fail the pack.
    const sellerIntent = intake.value.sellerIntent;
    if (sellerIntent) {
      try {
        await store.saveSellerIntent?.(input.jobId, sellerIntent);
      } catch (intentErr) {
        console.warn(`[runner] could not record the seller intent for job ${input.jobId}`, intentErr);
      }
    }
    // Screenshots (docs/phases/PHASE_12.md A5): a screen capture is never
    // the product, so a photo intake flags is left out of analysis, planning
    // and every shot. A pack of nothing but screenshots stops here, before
    // any spend past the intake call.
    const cameraVerdicts = intake.value.images.filter((img) => img.screenshot !== true);
    if (cameraVerdicts.length === 0) {
      throw new Error(SCREENSHOT_UPLOAD_MESSAGE);
    }
    if (!cameraVerdicts.some((img) => img.sellableProduct)) {
      throw new Error(noSellableProductMessage(cameraVerdicts));
    }
    const judged = judgedImages.map((image) => image.mediaId);
    const screenshots = screenshotMediaIds(intake.value, judged, input.jobId);
    const images = input.images.filter((image) => !screenshots.has(image.mediaId));
    // The analyzer keeps its own, smaller image budget.
    const cameraPhotos = shown
      .filter((photo) => !screenshots.has(photo.mediaId))
      .slice(0, ANALYZE_PHOTO_LIMIT)
      .map((photo) => photo.block);
    if (images.length === 0) {
      throw new Error(SCREENSHOT_UPLOAD_MESSAGE);
    }
    if (screenshots.size > 0) {
      console.warn(`[runner] job ${input.jobId} left out ${screenshots.size} photo(s) intake judged screenshots`);
    }
    // Moderation gate on the intake flags (plan 4.5.2): flagged uploads never
    // reach generation. Credits release through the failure path.
    const intakeBlock = moderationBlockReasons(intake.value, null);
    if (intakeBlock.length > 0) {
      throw new Error(moderationBlockedMessage(intakeBlock));
    }
    // Product inventory (docs/phases/PHASE_13.md): every camera photo is cut
    // out once, split into its pieces and reconciled with intake, so how many
    // products a photo shows and which one the pack features never rests on
    // one model answer. The shots of each photo reuse the same cutout.
    const taken = await takeInventory(deps, input, judgedImages, screenshots, assertLive, (micros) => {
      costMicros += micros;
    });
    const cutouts = new Map([...taken].map(([mediaId, photo]) => [mediaId, photo.inventory]));
    // The product each photo is for. A photo with several products and no
    // single match to the seller's note stops the pack here, before any paid
    // generation; the failure path releases the held credits.
    let { selection, photos: inventoryPhotos } = inventorySelection(
      intake.value,
      judgedImages,
      cutouts,
      input.userDescription,
      input.jobId,
    );
    // The vision tie breaker: a photo of 2 to 6 pieces the rules left
    // ambiguous or in conflict, with a note to go on, is shown to the
    // target_picker recipe before the pack fails. Its spend is booked on the
    // job like every LLM call; an answer visionDecision refuses changes
    // nothing, so the pack fails as before with no credits charged.
    const picks = new Map<string, VisionPick>();
    for (const photo of inventoryPhotos) {
      const cutout = taken.get(photo.record.mediaId)?.cutout;
      if (!photo.pickable || !cutout) {
        continue;
      }
      const index = judgedImages.findIndex((image) => image.mediaId === photo.record.mediaId);
      const image = intake.value.images.length === judgedImages.length ? intake.value.images[index] : undefined;
      await assertLive();
      const pick = await askTargetPicker(
        deps,
        recipes,
        input,
        sellerIntent ?? null,
        {
          mediaId: photo.record.mediaId,
          photo: index + 1,
          inventory: cutouts.get(photo.record.mediaId) as CutoutInventory,
          cutout,
          products: image?.products ?? [],
        },
        bookedLlm,
      );
      if (pick) {
        picks.set(photo.record.mediaId, pick);
      }
    }
    taken.clear();
    if (picks.size > 0) {
      ({ selection, photos: inventoryPhotos } = inventorySelection(
        intake.value,
        judgedImages,
        cutouts,
        input.userDescription,
        input.jobId,
        picks,
      ));
    }
    if (inventoryPhotos.length > 0) {
      try {
        await store.saveInventory?.(input.jobId, {
          version: 1,
          photos: inventoryPhotos.map((photo) => photo.record),
        });
      } catch (inventoryErr) {
        console.warn(`[runner] could not record the inventory for job ${input.jobId}`, inventoryErr);
      }
    }
    const ambiguous = selection.ambiguous.filter((mediaId) => !screenshots.has(mediaId));
    if (ambiguous.length > 0) {
      throw new Error(MULTIPLE_PRODUCTS_MESSAGE);
    }
    const targets = selection.targets;
    const exclude = sellerIntent?.exclude ?? [];

    const analysis = await bookedLlm(
      llmJson<ProductProfile>(
        deps.ai,
        recipeFor(recipes, "analyze"),
        ProductProfile,
        { images, userDescription: wrapUserDescription(input.userDescription) },
        { jobId: input.jobId, workspaceId: input.workspaceId, stepId: "analyze" },
        cameraPhotos,
        ProductProfile,
      ),
    );
    if (!analysis.value) {
      throw new Error("Product analysis response failed schema validation");
    }
    const profileBlock = moderationBlockReasons(intake.value, analysis.value);
    if (profileBlock.length > 0) {
      throw new Error(moderationBlockedMessage(profileBlock));
    }
    // A photo the seller marked with a role is that angle, whatever the
    // analyzer saw, so the planner plans it from that exact photo.
    const profile = withSellerAngles(
      analysis.value,
      images.map((image) => image.angle),
    );
    await store.saveProfile?.(input.jobId, profile);

    // Plan shots: LLM planner recipe first, validated and repriced from the
    // seed; the deterministic planner when it is rejected. Concept mode
    // drops marketplace channels before planning; the exclusion is
    // structural, not a pricing convention. Shot methods no live provider
    // delivers yet are left out before any budget check, on both paths, so
    // they never cost a deliverable shot its place (Update.md 1.7).
    await advance(transition(state, "analysis_done"));
    const mode = input.mode ?? "listing";
    const conceptExcluded = mode === "concept" ? input.channels.filter((c) => isMarketplaceChannel(c)) : [];
    const effectiveChannels = input.channels.filter((c) => !conceptExcluded.includes(c));
    // The photo the seller marked as the front leads; otherwise the first.
    const primaryMediaId = (images.find((image) => image.angle === "front") ?? images[0])?.mediaId;
    const excludeMethods = [...new Set(deps.excludeShotMethods ?? [])];
    const sellerCopy = sellerCopyOf(input);
    const angleMedia = mediaIdsByAngle(images);
    // The LLM planner sees whether the seller supplied box contents and
    // comparison facts, never the text itself: seller text only ever reaches
    // an image through withSellerCopy below, exactly as typed.
    const planOptions: RunnerPlanOptions = {
      channels: effectiveChannels,
      tier: input.tier,
      creditBudget: input.creditBudget,
      hasBoxContents: sellerCopy.boxContents.length > 0,
      hasComparisonFacts: sellerCopy.comparisonFacts.length > 0,
      hasVideoSource: input.hasVideoSource,
      ...(Object.keys(angleMedia).length > 0 ? { mediaIdsByAngle: angleMedia } : {}),
      primaryMediaId,
      ...(excludeMethods.length > 0 ? { undeliverableMethods: excludeMethods } : {}),
    };
    const planned = await bookedLlm(
      llmJson<unknown>(
        deps.ai,
        recipeFor(recipes, "plan"),
        { safeParse: (data: unknown) => ({ success: true, data }) },
        { profile, options: planOptions },
        { jobId: input.jobId, workspaceId: input.workspaceId, stepId: "plan" },
        undefined,
        ShotList,
      ),
    );
    const fit: FitOptions = {
      channels: effectiveChannels,
      mode,
      budget: input.creditBudget,
      profile,
      primaryMediaId,
      excludeMethods,
    };
    // The deterministic plan is the fallback, and the bar an LLM plan must
    // meet: every picked spec it delivers at this budget needs a file in the
    // fitted LLM plan too (a Walmart pick next to Amazon, say), or the LLM
    // plan is rejected and this one runs. Coverage is checked after
    // fitShotsToChannels, which fills slots the LLM plan leaves to the runner,
    // such as Google's main image. A deterministic planner failure never
    // sinks a valid LLM plan.
    let fallback: ShotList | null = null;
    try {
      fallback = deterministicPlan(profile, { ...planOptions, ...sellerCopy }, fit);
    } catch (planErr) {
      console.error(`[runner] job ${input.jobId} deterministic plan failed`, planErr);
    }
    const check = validateLlmShotList(planned.raw, {
      budget: input.creditBudget,
      mediaIds: images.map((image) => image.mediaId),
      channels: effectiveChannels,
      mode,
      requireAmazonMain: profile.imageQuality.usableForMain && profile.photographedAngles.includes("front"),
      excludeMethods,
    });
    let chosen: ShotList | null = null;
    if (check.ok) {
      const fitted = fitShotsToChannels(check.shotList, fit);
      const fittedSpecs = coveredSpecs(fitted.shots);
      const uncovered = fallback ? [...coveredSpecs(fallback.shots)].filter((specId) => !fittedSpecs.has(specId)) : [];
      if (uncovered.length === 0) {
        chosen = fitted;
        plannerSource = "llm";
      } else {
        planRejection = `the plan has no shot for ${uncovered.join(", ")}`;
      }
    } else {
      planRejection = check.reason;
    }
    if (!chosen) {
      // Only an actual plan that was turned down is worth a log line; a
      // response with no shots at all (demo mode) just falls back.
      const attempted =
        !!planned.raw && typeof planned.raw === "object" && Array.isArray((planned.raw as { shots?: unknown }).shots);
      if (attempted) {
        console.warn(`[runner] job ${input.jobId} LLM shot plan rejected: ${planRejection}`);
      }
      if (!fallback) {
        throw new Error(PLAN_FAILED_MESSAGE);
      }
      chosen = fallback;
      plannerSource = "deterministic";
    }
    // The brand kit's style preset, when it names one, replaces the
    // planner's category pick on every shot that uses a preset.
    const shotList: ShotList = withSellerCopy(applyBrandStylePreset(chosen, input.brand?.stylePreset, profile), sellerCopy);
    plannedShots = shotList.shots.length;
    skipped = [
      ...conceptExcluded.map((channel) => ({
        type: channel,
        reason: "concept mode excludes marketplace channels",
      })),
      ...shotList.skipped,
    ];
    try {
      await store.savePlan?.({ jobId: input.jobId, workspaceId: input.workspaceId, shots: shotList.shots, skipped });
    } catch (planErr) {
      console.warn(`[runner] could not record the plan for job ${input.jobId}`, planErr);
    }

    // Fan out per shot generation, each shot carrying its own QC retry loop.
    await advance(transition(state, "plan_ready"), {
      plannerSource,
      ...(planRejection !== undefined ? { planRejection } : {}),
    });
    const ctx: ShotContext = {
      jobId: input.jobId,
      workspaceId: input.workspaceId,
      sku: input.sku,
      seoSlug: input.seoSlug,
      mode,
      brandColors: input.brandColors,
      recipes,
      ...(input.brand ? { brand: input.brand } : {}),
      ...(input.runKey ? { runKey: input.runKey } : {}),
      ...(Object.keys(targets).length > 0 ? { targets } : {}),
      ...(exclude.length > 0 ? { exclude } : {}),
    };
    // Pack level spend cap: a shared tracker gates every generation attempt
    // across the parallel fan out, so a runaway pack stops mid flight. The
    // shots it stops go to needs review; what already passed still ships.
    let fanOutDeps = deps;
    if (deps.packCostCapMicros !== undefined) {
      const cap = deps.packCostCapMicros;
      const baseCost = costMicros;
      let generatedCostMicros = 0;
      const inner = deps.generator;
      const gate = (): void => {
        if (baseCost + generatedCostMicros >= cap) {
          throw new ShotUnavailableError(PACK_CAP_REACHED);
        }
      };
      // Spend of a failed attempt counts toward the cap too.
      const tracked = async (run: () => Promise<ShotGeneration>): Promise<ShotGeneration> => {
        gate();
        try {
          const generation = await run();
          generatedCostMicros += generation.costMicros;
          return generation;
        } catch (err) {
          generatedCostMicros += generationFailure(err).costMicros;
          throw err;
        }
      };
      fanOutDeps = {
        ...deps,
        generator: {
          generate: (args) => tracked(() => inner.generate(args)),
          ...(inner.deriveForSpec
            ? {
                deriveForSpec: (args: ShotGenerateArgs, from: ShotGeneration, specId: string) =>
                  tracked(() => inner.deriveForSpec!(args, from, specId)),
              }
            : {}),
        },
      };
    }
    // One shot failing never takes its siblings down: a shot that throws
    // outside its own QC loop becomes needs review (Update.md 3.3).
    const runShots =
      deps.runShots ??
      (async (shots: Shot[], c: ShotContext): Promise<ShotOutcome[]> => {
        const settledShots = await allSettledWithLimit(
          shots,
          deps.shotConcurrency ?? DEFAULT_SHOT_CONCURRENCY,
          (s) => runShot(s, c, fanOutDeps),
        );
        return Promise.all(
          settledShots.map((result, i) =>
            result.status === "fulfilled" ? result.value : recordShotFailure(store, shots[i], c, result.reason),
          ),
        );
      });
    const outcomes = await runShots(shotList.shots, ctx);
    costMicros += outcomes.reduce((sum, o) => sum + o.costMicros, 0);

    // QC accounting, part one: release every shot that needs review now.
    // Passing shots stay held until their files are delivered (below), so a
    // pack that never ships is never charged.
    await advance(transition(state, "shots_generated"));
    const passing = outcomes.filter((o) => o.status === "passed");
    for (const outcome of outcomes) {
      if (outcome.status !== "passed") {
        needsReview += 1;
        if (outcome.credits > 0) {
          await applyLedger(ledger.releaseForFailedShot(outcome.shotId, outcome.credits));
        }
      }
    }
    // A pack fails only when nothing in it can be delivered.
    if (passing.length === 0) {
      throw new Error(noShotPassedMessage(outcomes));
    }

    // Packaging: one zip per selected channel family, one file per passing
    // channel output. The packager decodes each file when it checks it.
    // Liveness is checked right before packaging and right before the pack
    // is saved: a pack the web app settled meanwhile (its inline run cap, a
    // shutdown, the stale run reconciler) released its hold, so it must not
    // deliver files nobody pays for. The store's savePack checks again,
    // atomically with the rows that deliver the pack.
    await advance(transition(state, "qc_done"));
    await assertLive();
    const packAssets = passing
      .flatMap((o) => o.packAssets ?? [])
      .map((asset) => (input.socialBadge && badgeEligible(asset.specId) ? { ...asset, badge: true } : asset));
    const families = [...selectedFamilies(effectiveChannels)];
    const built = await buildPack(packAssets, families, {
      outDir: deps.packOutDir,
      writeFiles: true,
      intent: enforcedIntent(targets, exclude),
      inventory: packInventory(inventoryPhotos, judgedImages),
    });
    if (built.report.files.length === 0) {
      throw new Error("None of the shots in this pack could be delivered, so nothing was charged.");
    }
    const toSave: StoredPack = {
      jobId: input.jobId,
      workspaceId: input.workspaceId,
      outDir: built.outDir,
      channels: built.report.channels,
      files: built.report.files.length,
      reportPath: built.reportPath,
    };
    await assertLive();
    await store.savePack(toSave);
    pack = toSave;

    // QC accounting, part two: charge each passing shot once, and only when
    // at least one of its files is in the delivered pack (a ref in
    // report.files). A shot the packager left out, for example a ninth
    // amazon.secondary over the channel image limit, is released like a
    // shot that needs review (Update.md 2.10, 2.12). The heartbeat keeps
    // the reconciler off the job while the charges land.
    const delivered = new Set(
      built.report.files.map((f) => f.ref).filter((ref): ref is string => ref !== null),
    );
    const droppedFor = new Map<string, string>();
    for (const drop of built.report.dropped) {
      if (drop.ref !== null && !droppedFor.has(drop.ref)) {
        droppedFor.set(drop.ref, drop.reason);
      }
    }
    await store.heartbeat?.(input.jobId);
    for (const outcome of passing) {
      if (delivered.has(outcome.shotId)) {
        passed += 1;
        if (outcome.credits > 0) {
          await applyLedger(ledger.chargeForPassingAsset(outcome.shotId, outcome.credits));
        }
        continue;
      }
      needsReview += 1;
      const reason = droppedFor.get(outcome.shotId) ?? "no file was delivered";
      console.warn(`[runner] job ${input.jobId} shot ${outcome.shotId} passed but was not delivered: ${reason}`);
      if (outcome.credits > 0) {
        await applyLedger(ledger.releaseForUndeliveredShot(outcome.shotId, outcome.credits, reason));
      }
      try {
        await store.markShotUndelivered?.({
          jobId: input.jobId,
          workspaceId: input.workspaceId,
          shotId: outcome.shotId,
          shotType: outcome.shotType,
          reason: reason.startsWith(CHANNEL_LIMIT_REASON) ? SHOT_CHANNEL_FULL : SHOT_NOT_DELIVERED,
        });
      } catch (markErr) {
        console.warn(`[runner] could not mark shot ${outcome.shotId} as not delivered`, markErr);
      }
    }
    await applyLedger(ledger.releaseUnusedOnCompletion());
    // From here the pack is delivered and fully settled; a failure writing
    // the final state must not turn a charged, delivered pack into "failed".
    settled = true;
    await advance(transition(state, "packaged"), { passed, needsReview, costMicros });

    return summarize("done");
  } catch (err) {
    if (settled && !(err instanceof JobAbandonedError)) {
      try {
        await store.setJobState(input.jobId, "done", { passed, needsReview, costMicros });
      } catch (retryErr) {
        console.error(`[runner] job ${input.jobId} is delivered and settled but its done state could not be saved`, retryErr);
      }
      return summarize("done");
    }
    const message =
      err instanceof AllProvidersFailedError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    // The failure path must never throw out of the runner (a throw here
    // would leave the job row stuck in a working state): mark the job failed
    // first so the board shows it, then return whatever the ledger holds.
    if (!isTerminal(state)) {
      state = transition(state, "fail");
    }
    try {
      await store.setJobState(input.jobId, "failed", { error: message, costMicros });
    } catch (stateErr) {
      console.error(`[runner] could not mark job ${input.jobId} failed`, stateErr);
    }
    try {
      const release = ledger.releaseRemainderOnFailure("failed");
      // A job settled elsewhere already had its hold released there, so an
      // exact release would be refused as more than is held; the sweep
      // below returns anything that is somehow still held.
      if (!(err instanceof JobAbandonedError)) {
        await applyLedger(release);
      }
    } catch (releaseErr) {
      console.error(`[runner] planned release failed for job ${input.jobId}`, releaseErr);
    }
    try {
      await store.releaseAllHeld?.(input.jobId, input.workspaceId);
    } catch (sweepErr) {
      console.error(`[runner] release sweep failed for job ${input.jobId}`, sweepErr);
    }
    return summarize("failed", message);
  }
}
