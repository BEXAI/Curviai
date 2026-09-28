/**
 * Pure orchestration of the generate pack pipeline (CURVI_BUILD_PLAN.md
 * sections 4.4 and 5.5 to 5.7). Everything here is plain async code over
 * injected dependencies: the AI layer, a job store, a clock and a shot
 * generator. The Trigger.dev task files are thin wrappers around these
 * functions, so the whole flow is unit testable with @curvi/ai mocks.
 *
 * Flow: intake and analyze through the LLM recipes, plan shots (LLM planner,
 * validated and repriced from the seed, with the deterministic planner as
 * fallback), fit every shot to the selected channel families, fan out per
 * shot generation, QC each channel output of each shot with deterministic
 * pixel checks on the shipped bytes plus a fidelity report and the planRetry
 * loop, package via buildPack, and account for credits with JobLedgerPlan:
 * reserve on queued, charge per passing shot after delivery, release for
 * shots that need review and on failure. One failing shot never fails the
 * pack; a pack fails only when no shot passes.
 */

import {
  AllProvidersFailedError,
  callWithFailover,
  type BreakerStore,
  type CapsHook,
  type CostMeter,
  type ProviderRegistry,
  type RoutingTable,
  type SpendCaps,
} from "@curvi/ai";
import {
  buildPack,
  channelOf,
  decodeToRgba,
  fidelityReport,
  pixelChecks,
  planRetry,
  encodeVisionJpeg,
  planShots,
  qcKindForSpec,
  IntakeResult,
  ProductProfile,
  QCVerdict,
  ShotList,
  type DigitalSourceKind,
  type FidelityReport,
  type PackAsset,
  type PixelCheckReport,
  type PlanOptions,
  type RawImage,
  type RawMask,
  type Shot,
} from "@curvi/pipeline";
import { creditCosts, recipeSeedRows, type RecipeRow, type TierKey } from "@curvi/pipeline/seed";
import { getSpec, hasSpec, isMarketplaceSpec, listSpecs, type ChannelSpec } from "@curvi/specs";
import { z } from "zod";
import { ShotUnavailableError } from "./errors";
import {
  canvasSizeFor,
  decodeMaskPng,
  encodeMaskPng,
  measureBackgroundRgb,
  QC_EDGE_MARGIN_PX,
} from "./shot-outputs";
import { isTerminal, JobLedgerPlan, transition, type JobState, type LedgerAction } from "./state";

export type { JobState } from "./state";
export { ShotUnavailableError } from "./errors";

/** Plain copy for a shot that ended on an unexpected provider or runtime error. */
export const SHOT_PROVIDER_TROUBLE = "Our image provider had trouble with this shot, so it needs review.";
/** Plain copy for a shot the pack spend cap stopped before it ran. */
const PACK_CAP_REACHED =
  "This pack reached its spending limit before this shot could be made, so it needs review.";

/** Recipe row for a pipeline stage, looked up from seed data so task names,
 * models and prompts are never hardcoded here (CLAUDE.md rule 2). */
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
}

/** True when a provider chain failed because a spend cap refused at least
 * one provider. The remaining providers failing too (breaker open, outage)
 * does not change that the cap is what stopped the shot, so it goes to needs
 * review rather than failing the whole pack. */
export function isSpendCapBlock(err: unknown): boolean {
  return (
    err instanceof AllProvidersFailedError &&
    err.errors.some((e) => e.message.startsWith("Spend cap blocked"))
  );
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
  readonly ledger: JobLedgerEntry[] = [];
  readonly assets: StoredAsset[] = [];
  readonly packs: StoredPack[] = [];

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
}

export interface ShotGenerator {
  generate(args: ShotGenerateArgs): Promise<ShotGeneration>;
  /**
   * Builds this shot's output for another channel spec from an accepted
   * generation, without new provider spend (Update.md 2.11). Optional: a
   * generator without it is asked to generate that spec directly.
   */
  deriveForSpec?(args: ShotGenerateArgs, from: ShotGeneration, specId: string): Promise<ShotGeneration>;
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

export interface ShotOutcome extends ShotOutcomeBase {
  /** One file per passing channel output; feeds buildPack. */
  packAssets?: PackAsset[];
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
    packAssets.map(async (asset): Promise<SerializedPackFile> => ({
      specId: asset.specId,
      encodedBase64: asset.buffer.toString("base64"),
      ...(asset.format !== undefined ? { format: asset.format } : {}),
      ...(asset.mask ? { maskPngBase64: (await encodeMaskPng(asset.mask)).toString("base64") } : {}),
      ...(asset.edgeMarginPx !== undefined ? { edgeMarginPx: asset.edgeMarginPx } : {}),
    })),
  );
  return { ...base, files };
}

/**
 * Rebuilds pack assets on the pack task side. The raw pixels are decoded
 * from the shipped bytes, which is exactly what QC measured in the subtask,
 * so the compliance report keeps its measured pixel checks in Trigger mode
 * instead of falling back to file level checks.
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
  outcome.packAssets = await Promise.all(
    files.map(async (file): Promise<PackAsset> => {
      const buffer = Buffer.from(file.encodedBase64, "base64");
      const raw = await decodeToRgba(buffer).catch(() => undefined);
      const mask = file.maskPngBase64
        ? await decodeMaskPng(Buffer.from(file.maskPngBase64, "base64")).catch(() => undefined)
        : undefined;
      return {
        specId: file.specId,
        buffer,
        format: file.format,
        ...(raw ? { raw } : {}),
        ...(mask ? { mask } : {}),
        ...(file.edgeMarginPx !== undefined ? { edgeMarginPx: file.edgeMarginPx } : {}),
        sku: ctx.sku,
        seoSlug: ctx.seoSlug,
        ref: base.shotId,
        digitalSource: base.digitalSource,
      };
    }),
  );
  return outcome;
}

export interface PipelineDeps {
  ai: AiDeps;
  store: JobStore;
  clock: Clock;
  generator: ShotGenerator;
  /** Loads source media bytes for LLM vision input; metadata only when absent. */
  loadMedia?: (mediaId: string) => Promise<Buffer | null>;
  /** Shot methods to skip after planning, e.g. video until its provider is wired. */
  excludeShotMethods?: Array<Shot["method"]>;
  /** Spend ceiling per shot including retries; further attempts stop at it. */
  assetCostCapMicros?: number;
  /** Spend ceiling for the whole pack; the run fails when it is crossed. */
  packCostCapMicros?: number;
  /** Fan out override: the Trigger.dev wrapper points this at the
   * generate-shot subtask. Defaults to Promise.allSettled over runShot, with
   * a shot that throws turned into a needs review outcome. */
  runShots?: (shots: Shot[], ctx: ShotContext) => Promise<ShotOutcome[]>;
  /** Where buildPack writes zips. A temp dir when omitted. */
  packOutDir?: string;
  /** Called when the global daily spend crosses the alert line (plan 4.4:
   * $50 alert). Defaults to a console warning in the runtime wiring. */
  onSpendAlert?: (totalMicros: number) => void;
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
  images: Array<{ mediaId: string; url?: string }>;
  userDescription?: string;
  sku?: string;
  seoSlug?: string;
  hasBoxContents?: boolean;
  hasComparisonFacts?: boolean;
  hasVideoSource?: boolean;
  /** Workspace brand kit colors (hex), for brand colored stills. */
  brandColors?: string[];
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

/** Input shape sent to LLM providers, compatible with the Anthropic adapter. */
export interface LlmTaskInput {
  system: string;
  model: string;
  /** Content is a string, or an array of vision and text blocks. */
  messages: Array<{ role: "user" | "assistant"; content: unknown }>;
  /** Forced structured output tool definitions, when a schema is enforced. */
  tools?: unknown[];
  toolChoice?: unknown;
}

function sniffImageMime(bytes: Buffer): string {
  if (bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length > 11 && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length > 3 && bytes.toString("ascii", 0, 3) === "GIF") return "image/gif";
  return "image/jpeg";
}

/**
 * Anthropic vision blocks for the uploaded photos, so intake and the product
 * analyzer judge the actual pixels instead of metadata. Empty when the deps
 * carry no media loader (demo mode) or nothing loads.
 */
async function visionBlocks(
  deps: PipelineDeps,
  images: GeneratePackInput["images"],
  limit = 3,
): Promise<unknown[]> {
  if (!deps.loadMedia) {
    return [];
  }
  const blocks: unknown[] = [];
  for (const image of images.slice(0, limit)) {
    const bytes = await deps.loadMedia(image.mediaId).catch(() => null);
    if (!bytes || bytes.length === 0) {
      continue;
    }
    // Normalize to a bounded JPEG; a raw upload can exceed the vision API's
    // per image size limit. Fall back to the original if decoding fails.
    const normalized = await encodeVisionJpeg(bytes).catch(() => bytes);
    const mediaType = normalized === bytes ? sniffImageMime(bytes) : "image/jpeg";
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data: normalized.toString("base64") },
    });
  }
  return blocks;
}

interface LlmCall<T> {
  value: T | null;
  raw: unknown;
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

async function llmJson<T>(
  ai: AiDeps,
  stage: RecipeRow["stage"],
  schema: { safeParse: (data: unknown) => { success: boolean; data?: T } },
  payload: unknown,
  ctx: { jobId: string; workspaceId: string; stepId: string },
  contentBlocks?: unknown[],
  outputSchema?: z.ZodType,
): Promise<LlmCall<T>> {
  const recipe = activeRecipe(stage);
  const text = JSON.stringify(payload);
  const content: unknown =
    contentBlocks && contentBlocks.length > 0 ? [...contentBlocks, { type: "text", text }] : text;
  const input: LlmTaskInput = {
    system: recipe.body.system,
    model: recipe.model,
    messages: [{ role: "user", content }],
  };
  if (outputSchema) {
    // Forced tool call per plan 5.2: the model must answer with structured
    // data matching the schema instead of free text that may not parse.
    input.tools = [
      {
        name: "emit_result",
        description: "Return the task result as structured data matching the schema exactly.",
        input_schema: z.toJSONSchema(outputSchema),
      },
    ];
    input.toolChoice = { type: "tool", name: "emit_result" };
  }
  const result = await callWithFailover<LlmTaskInput, unknown>(
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
    { caps: llmCapsHooks(ai) },
  );
  const raw = extractJsonOutput(result.output);
  const parsed = schema.safeParse(raw);
  return {
    value: parsed.success ? (parsed.data as T) : null,
    raw,
    costMicros: result.costMicros,
  };
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
  packAsset?: PackAsset;
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
 * Returns a refusal reason when a cap blocks.
 */
async function settleGenerationSpend(
  shot: Shot,
  ctx: ShotContext,
  deps: PipelineDeps,
  generation: ShotGeneration,
): Promise<string | null> {
  if (deps.ai.caps && generation.spendReserved) {
    const global = await deps.ai.caps.checkAndReserveGlobalDay(0);
    if (global.alert) {
      deps.onSpendAlert?.(global.totalMicros);
    }
  } else if (deps.ai.caps && generation.costMicros > 0) {
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
      });
    } catch (err) {
      if (err instanceof ShotUnavailableError) {
        spent.micros += err.costMicros;
        return stop(err.message, false);
      }
      // A provider outage on this shot (for example every image or cutout
      // provider failing) ends this shot only; its siblings carry on.
      console.error(`[runner] shot ${shot.id} for ${specId} failed on attempt ${attempt}`, err);
      return stop(SHOT_PROVIDER_TROUBLE, true, errorDetail(err));
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

    let verdict: QCVerdict;
    try {
      const judged = await llmJson<QCVerdict>(
        deps.ai,
        "qc",
        QCVerdict,
        {
          shot: { id: shot.id, type: shot.type, scene: shot.scene, channel: specId },
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
        packAsset: packAssetFor(shot, specId, ctx, generation, checked.shipped),
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

function packAssetFor(
  shot: Shot,
  specId: string,
  ctx: ShotContext,
  generation: ShotGeneration,
  shipped: RawImage,
): PackAsset {
  return {
    specId,
    buffer: generation.encoded.buffer,
    format: generation.encoded.format,
    raw: shipped,
    mask: generation.mask ?? undefined,
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
  const args: ShotGenerateArgs = {
    shot: target,
    attempt: 1,
    useFallbackProvider: false,
    jobId: ctx.jobId,
    workspaceId: ctx.workspaceId,
    brandColors: ctx.brandColors,
  };
  let generation: ShotGeneration;
  try {
    generation = deps.generator.deriveForSpec
      ? await deps.generator.deriveForSpec(args, from, specId)
      : await deps.generator.generate(args);
  } catch (err) {
    if (err instanceof ShotUnavailableError) {
      spent.micros += err.costMicros;
      return stop(err.message, false);
    }
    console.error(`[runner] shot ${shot.id} could not be prepared for ${specId}`, err);
    return stop("This image could not be prepared for this channel, so it needs review.", false, errorDetail(err));
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
  const verdict = deterministicVerdict(pixel, fidelity);
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
    ? { summary, packAsset: packAssetFor(shot, specId, ctx, generation, checked.shipped), stopShot: false }
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
  deps: PipelineDeps,
): Promise<ShotOutcome> {
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
    ...(passedRuns.length > 0 ? { packAssets: passedRuns.map((r) => r.packAsset as PackAsset) } : {}),
    ...(passedRuns.length === 0 && failure !== undefined ? { failure } : {}),
  };
  await deps.store.saveAsset(toStoredAsset(outcome, ctx));
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
    await store.saveAsset(toStoredAsset(outcome, ctx));
  } catch (saveErr) {
    console.error(`[runner] could not record failed shot ${shot.id}`, saveErr);
  }
  return outcome;
}

function toStoredAsset(outcome: ShotOutcome, ctx: ShotContext): StoredAsset {
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
 * that block generation outright. Returns the reasons, empty when clean. */
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
    if (flag === "none") continue;
    if (flag === "possible_counterfeit") reasons.add("a possible counterfeit");
    else if (flag === "prohibited") reasons.add("prohibited goods");
    else if (flag === "adult") reasons.add("adult content");
    else if (flag === "weapon") reasons.add("weapons");
  }
  return [...reasons];
}

/** True when the channel string, a spec id or a channel family, is
 * marketplace bound. Concept packs never target marketplace channels
 * (plan 2.7). */
export function isMarketplaceChannel(channel: string): boolean {
  if (hasSpec(channel)) {
    return isMarketplaceSpec(channel);
  }
  return listSpecs().some((s) => channelOf(s.id) === channel && isMarketplaceSpec(s.id));
}

/** Channel families of the selected channels ("amazon.main" and "amazon"
 * both select the amazon family). */
export function selectedFamilies(channels: readonly string[]): Set<string> {
  return new Set(channels.map((c) => channelOf(c)));
}

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
}

export type LlmPlanCheck = { ok: true; shotList: ShotList } | { ok: false; reason: string };

/**
 * An LLM shot list is used only when it validates against the schema, every
 * shot id is unique, every shot claims a positive cost (the real price is
 * then taken from the seed), every shot draws from one of this job's photos, every
 * channel is a known spec inside the selected channel families (and never a
 * marketplace spec in concept mode), at most one shot targets amazon.main and
 * it is the deterministic amazon_main, Amazon gets its main image when a
 * usable front photo exists, and the plan fits the budget once every shot is
 * repriced from the seed (Update.md 1.7). Otherwise the deterministic planner
 * runs, and the reason is reported.
 */
export function validateLlmShotList(raw: unknown, rules: LlmPlanRules): LlmPlanCheck {
  const parsed = ShotList.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "the plan did not match the shot list schema" };
  }
  const shots = parsed.data.shots;
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
  const mains = shots.filter((s) => s.channels.includes("amazon.main"));
  if (mains.length > 1) {
    return { ok: false, reason: "more than one shot targets amazon.main" };
  }
  if (mains.some((s) => s.type !== "amazon_main" || s.method !== "deterministic")) {
    return { ok: false, reason: "amazon.main must be the deterministic amazon_main shot" };
  }
  if (rules.mode === "listing" && rules.requireAmazonMain && families.has("amazon") && mains.length === 0) {
    return { ok: false, reason: "Amazon is selected but the plan has no amazon_main shot" };
  }
  const repriced = shots.map((s) => ({ ...s, credits: creditsForShot(s) }));
  const total = repriced.reduce((sum, s) => sum + s.credits, 0);
  if (total > rules.budget) {
    return { ok: false, reason: `the plan needs ${total} credits and the budget is ${rules.budget}` };
  }
  return { ok: true, shotList: { shots: repriced, skipped: parsed.data.skipped } };
}

export interface FitOptions {
  channels: readonly string[];
  mode: "listing" | "concept";
  budget: number;
  profile: ProductProfile;
  primaryMediaId?: string;
}

const GOOGLE_MAIN_SPEC = "google.merchant.main";

/**
 * Fits a plan to what the seller selected (Update.md 2.11). Every shot keeps
 * only the channel specs whose family was selected (never a marketplace spec
 * in concept mode); a shot left with none is skipped, so unselected channels
 * (for example social crops when no social channel was picked) cost nothing.
 * When Google is selected its main image slot is filled: the white main
 * image also ships to Google when there is one, otherwise a white front shot
 * is added within the budget. Shot ids are made unique.
 */
export function fitShotsToChannels(plan: ShotList, opts: FitOptions): ShotList {
  const families = selectedFamilies(opts.channels);
  const skipped = [...plan.skipped];
  const shots: Shot[] = [];
  for (const shot of plan.shots) {
    const kept = [
      ...new Set(
        shot.channels.filter(
          (c) => hasSpec(c) && families.has(channelOf(c)) && !(opts.mode === "concept" && isMarketplaceSpec(c)),
        ),
      ),
    ];
    if (kept.length === 0) {
      skipped.push({ type: shot.type, reason: "channel not selected" });
      continue;
    }
    shots.push({ ...shot, channels: kept });
  }

  if (opts.mode === "listing" && families.has(channelOf(GOOGLE_MAIN_SPEC)) && !shots.some((s) => s.channels.includes(GOOGLE_MAIN_SPEC))) {
    const whiteMain = shots.find((s) => s.type === "amazon_main" && s.method === "deterministic");
    const frontUsable =
      opts.profile.imageQuality.usableForMain && opts.profile.photographedAngles.includes("front");
    if (whiteMain) {
      whiteMain.channels = [...whiteMain.channels, GOOGLE_MAIN_SPEC];
    } else if (!frontUsable || !opts.primaryMediaId) {
      skipped.push({ type: "google_main", reason: "needs photo" });
    } else {
      const shot: Shot = {
        id: "s00_google_main",
        type: "alt_angle_white",
        sourceMediaId: opts.primaryMediaId,
        method: "deterministic",
        channels: [GOOGLE_MAIN_SPEC],
        stylePreset: "none",
        credits: creditsForShot({ type: "alt_angle_white", method: "deterministic" }),
        priority: 1,
      };
      const total = shots.reduce((sum, s) => sum + s.credits, 0);
      if (total + shot.credits <= opts.budget) {
        shots.unshift(shot);
      } else {
        skipped.push({ type: "google_main", reason: "credit budget" });
      }
    }
  }

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
  deps: PipelineDeps,
): Promise<GeneratePackSummary> {
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

  if ((await store.setJobState(input.jobId, state)) === false) {
    // Already terminal before this run started (for example reconciled while
    // it waited in the queue); its reservation was settled there.
    return summarize("failed", new JobAbandonedError(input.jobId).message);
  }
  await applyLedger(ledger.reserveOnQueue(input.creditBudget));

  try {
    // Intake and analyze, with the uploaded photos as vision input when a
    // media loader is wired.
    await advance(transition(state, "start_analysis"));
    const photos = await visionBlocks(deps, input.images);
    const intake = await llmJson<IntakeResult>(
      deps.ai,
      "intake",
      IntakeResult,
      { images: input.images, userDescription: wrapUserDescription(input.userDescription) },
      { jobId: input.jobId, workspaceId: input.workspaceId, stepId: "intake" },
      photos,
      IntakeResult,
    );
    costMicros += intake.costMicros;
    if (!intake.value) {
      throw new Error("Intake response failed schema validation");
    }
    if (!intake.value.images.some((img) => img.sellableProduct)) {
      throw new Error("Intake found no sellable product in the uploaded images");
    }
    // Moderation gate on the intake flags (plan 4.5.2): flagged uploads never
    // reach generation. Credits release through the failure path.
    const intakeBlock = moderationBlockReasons(intake.value, null);
    if (intakeBlock.length > 0) {
      throw new Error(`This upload was flagged for ${intakeBlock.join(", ")} and needs a manual review before a pack can run`);
    }

    const analysis = await llmJson<ProductProfile>(
      deps.ai,
      "analyze",
      ProductProfile,
      { images: input.images, userDescription: wrapUserDescription(input.userDescription) },
      { jobId: input.jobId, workspaceId: input.workspaceId, stepId: "analyze" },
      photos,
      ProductProfile,
    );
    costMicros += analysis.costMicros;
    if (!analysis.value) {
      throw new Error("Product analysis response failed schema validation");
    }
    const profile = analysis.value;
    const profileBlock = moderationBlockReasons(intake.value, profile);
    if (profileBlock.length > 0) {
      throw new Error(`This product was flagged for ${profileBlock.join(", ")} and needs a manual review before a pack can run`);
    }
    await store.saveProfile?.(input.jobId, profile);

    // Plan shots: LLM planner recipe first, validated and repriced from the
    // seed; the deterministic planShots when it is rejected. Concept mode
    // drops marketplace channels before planning; the exclusion is
    // structural, not a pricing convention.
    await advance(transition(state, "analysis_done"));
    const mode = input.mode ?? "listing";
    const conceptExcluded = mode === "concept" ? input.channels.filter((c) => isMarketplaceChannel(c)) : [];
    const effectiveChannels = input.channels.filter((c) => !conceptExcluded.includes(c));
    const primaryMediaId = input.images[0]?.mediaId;
    const planOptions: PlanOptions = {
      channels: effectiveChannels,
      tier: input.tier,
      creditBudget: input.creditBudget,
      hasBoxContents: input.hasBoxContents,
      hasComparisonFacts: input.hasComparisonFacts,
      hasVideoSource: input.hasVideoSource,
      primaryMediaId,
    };
    const planned = await llmJson<unknown>(
      deps.ai,
      "plan",
      { safeParse: (data: unknown) => ({ success: true, data }) },
      { profile, options: planOptions },
      { jobId: input.jobId, workspaceId: input.workspaceId, stepId: "plan" },
      undefined,
      ShotList,
    );
    costMicros += planned.costMicros;
    const check = validateLlmShotList(planned.raw, {
      budget: input.creditBudget,
      mediaIds: input.images.map((image) => image.mediaId),
      channels: effectiveChannels,
      mode,
      requireAmazonMain: profile.imageQuality.usableForMain && profile.photographedAngles.includes("front"),
    });
    let shotList: ShotList;
    if (check.ok) {
      shotList = check.shotList;
      plannerSource = "llm";
    } else {
      planRejection = check.reason;
      // Only an actual plan that was turned down is worth a log line; a
      // response with no shots at all (demo mode) just falls back.
      const attempted =
        !!planned.raw && typeof planned.raw === "object" && Array.isArray((planned.raw as { shots?: unknown }).shots);
      if (attempted) {
        console.warn(`[runner] job ${input.jobId} LLM shot plan rejected: ${check.reason}`);
      }
      shotList = planShots(profile, planOptions);
      plannerSource = "deterministic";
    }
    shotList = fitShotsToChannels(shotList, {
      channels: effectiveChannels,
      mode,
      budget: input.creditBudget,
      profile,
      primaryMediaId,
    });
    if (deps.excludeShotMethods && deps.excludeShotMethods.length > 0) {
      const excluded = new Set(deps.excludeShotMethods);
      const kept = shotList.shots.filter((shot) => !excluded.has(shot.method));
      for (const shot of shotList.shots) {
        if (excluded.has(shot.method)) {
          shotList.skipped.push({ type: shot.type, reason: "provider not enabled" });
        }
      }
      shotList = { shots: kept, skipped: shotList.skipped };
    }
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
      fanOutDeps = {
        ...deps,
        generator: {
          generate: async (args) => {
            gate();
            const generation = await inner.generate(args);
            generatedCostMicros += generation.costMicros;
            return generation;
          },
          ...(inner.deriveForSpec
            ? {
                deriveForSpec: async (args: ShotGenerateArgs, from: ShotGeneration, specId: string) => {
                  gate();
                  const generation = await inner.deriveForSpec!(args, from, specId);
                  generatedCostMicros += generation.costMicros;
                  return generation;
                },
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
        const settledShots = await Promise.allSettled(shots.map((s) => runShot(s, c, fanOutDeps)));
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
    // channel output.
    await advance(transition(state, "qc_done"));
    const packAssets = passing.flatMap((o) => o.packAssets ?? []);
    const families = [...selectedFamilies(effectiveChannels)];
    const built = await buildPack(packAssets, families, {
      outDir: deps.packOutDir,
      writeFiles: true,
    });
    pack = {
      jobId: input.jobId,
      workspaceId: input.workspaceId,
      outDir: built.outDir,
      channels: built.report.channels,
      files: built.report.files.length,
      reportPath: built.reportPath,
    };
    await store.savePack(pack);

    // QC accounting, part two: the files are delivered, so charge each
    // passing shot once. The heartbeat keeps the reconciler off the job
    // while the charges land.
    await store.heartbeat?.(input.jobId);
    for (const outcome of passing) {
      passed += 1;
      if (outcome.credits > 0) {
        await applyLedger(ledger.chargeForPassingAsset(outcome.shotId, outcome.credits));
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
      await applyLedger(ledger.releaseRemainderOnFailure("failed"));
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
