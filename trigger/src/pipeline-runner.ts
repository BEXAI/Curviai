/**
 * Pure orchestration of the generate pack pipeline (CURVI_BUILD_PLAN.md
 * sections 4.4 and 5.5 to 5.7). Everything here is plain async code over
 * injected dependencies: the AI layer, a job store, a clock and a shot
 * generator. The Trigger.dev task files are thin wrappers around these
 * functions, so the whole flow is unit testable with @curvi/ai mocks.
 *
 * Flow: intake and analyze through the LLM recipes, plan shots (LLM planner
 * with the deterministic planner as fallback on schema invalid responses),
 * fan out per shot generation, QC each shot with deterministic pixel checks
 * plus a fidelity report for composites and the planRetry loop, package via
 * buildPack, and account for credits with JobLedgerPlan: reserve on queued,
 * charge per passing asset in qc, release for failed shots and on failure.
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
import { recipeSeedRows, type RecipeRow, type TierKey } from "@curvi/pipeline/seed";
import { getSpec, hasSpec, isMarketplaceSpec, listSpecs } from "@curvi/specs";
import { z } from "zod";
import { isTerminal, JobLedgerPlan, transition, type JobState, type LedgerAction } from "./state";

export type { JobState } from "./state";

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

/** Thrown by a shot generator that cannot honestly produce a shot, for
 * example a method live providers do not cover yet, a missing source photo
 * or a spend cap block. The shot goes to needs review and its credits are
 * released; nothing placeholder is ever delivered or charged. */
export class ShotUnavailableError extends Error {
  constructor(
    message: string,
    /** Provider spend already made for this attempt, so it stays on the books. */
    readonly costMicros = 0,
  ) {
    super(message);
    this.name = "ShotUnavailableError";
  }
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
  /** Mask erosion for the fidelity check when the product was scaled up: a
   * resize blends product and background across the kernel's reach, which
   * grows with the scale. Interior pixels are still checked strictly. */
  fidelityErodePx?: number;
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
}

export interface ShotOutcome extends ShotOutcomeBase {
  /** Present when the shot passed; feeds buildPack. */
  packAsset?: PackAsset;
}

/** JSON safe form of a shot outcome for the Trigger.dev subtask boundary. */
export interface SerializableShotOutcome extends ShotOutcomeBase {
  encodedBase64?: string;
  format?: string;
}

export function serializeShotOutcome(outcome: ShotOutcome): SerializableShotOutcome {
  const { packAsset, ...base } = outcome;
  if (!packAsset) {
    return base;
  }
  return {
    ...base,
    encodedBase64: packAsset.buffer.toString("base64"),
    format: packAsset.format,
  };
}

export function deserializeShotOutcome(
  serialized: SerializableShotOutcome,
  ctx: ShotContext,
): ShotOutcome {
  const { encodedBase64, format, ...base } = serialized;
  if (base.status !== "passed" || !encodedBase64) {
    return base;
  }
  return {
    ...base,
    packAsset: {
      specId: base.specId,
      buffer: Buffer.from(encodedBase64, "base64"),
      format,
      sku: ctx.sku,
      seoSlug: ctx.seoSlug,
      ref: base.shotId,
      digitalSource: base.digitalSource,
    },
  };
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
   * generate-shot subtask. Defaults to Promise.all over runShot. */
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

/**
 * Generate and QC one shot: generate, run pixelChecks against the shot's
 * channel spec, run fidelityReport for composite methods, ask the qc judge
 * recipe for a verdict (deterministic metrics win over its impression), and
 * loop per planRetry: up to 3 attempts with repairHint, one fallback
 * provider attempt, then needs review.
 */
export async function runShot(
  shot: Shot,
  ctx: ShotContext,
  deps: PipelineDeps,
): Promise<ShotOutcome> {
  const specId = shot.channels[0];
  const spec = getSpec(specId);
  let attempt = 1;
  let repairHint: string | undefined;
  let useFallbackProvider = false;
  let costMicros = 0;

  // A shot that ends without a usable image: needs review, credits released
  // by the pack runner, nothing delivered.
  const unusable = async (reason: string): Promise<ShotOutcome> => {
    const outcome: ShotOutcome = {
      shotId: shot.id,
      shotType: shot.type,
      specId,
      credits: shot.credits,
      status: "needs_review",
      attempts: attempt,
      usedFallbackProvider: useFallbackProvider,
      costMicros,
      verdict: { pass: false, fidelity: 0, issues: ["other"], repairHint: reason.slice(0, 300) },
      pixelPass: false,
      fidelityPass: null,
      digitalSource: digitalSourceFor(shot.method, ctx.mode),
      measured: { fillPct: null, background: null },
    };
    await deps.store.saveAsset(toStoredAsset(outcome, ctx));
    return outcome;
  };

  for (;;) {
    // The heartbeat doubles as a liveness check: once the job was settled
    // elsewhere (the stale reconciler failed it), stop before spending more.
    if ((await deps.store.heartbeat?.(ctx.jobId)) === false) {
      return unusable("The job was stopped before this shot finished.");
    }
    let generation: ShotGeneration;
    try {
      generation = await deps.generator.generate({
        shot,
        attempt,
        repairHint,
        useFallbackProvider,
        jobId: ctx.jobId,
        workspaceId: ctx.workspaceId,
        brandColors: ctx.brandColors,
      });
    } catch (err) {
      if (err instanceof ShotUnavailableError) {
        costMicros += err.costMicros;
        return unusable(err.message);
      }
      throw err;
    }
    costMicros += generation.costMicros;

    // Spend caps on the generation cost (plan 4.4). A cost capped shot goes
    // to needs review and releases its credits, per the 5.6 retry policy.
    // Generators that reserve before each provider call report it, and only
    // the alert check runs here (a zero reservation reads the global total).
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
        return unusable(`Cost cap reached: ${spend.reason ?? "spend cap"}`);
      }
    }

    const pixel = await pixelChecks(generation.image, generation.mask, spec, {
      encoded: { bytes: generation.encoded.buffer.length, format: generation.encoded.format },
      edgeMarginPx: 2,
    });

    // Rule 3 gate, fail closed: a composite or edit method that cannot prove
    // its paste back (no product reference or no mask) never passes.
    let fidelity: FidelityReport | null = null;
    let fidelityInputsMissing = false;
    // Live stills (deterministic and template) carry the rule 3 proof too:
    // any generation that supplies a reference is checked, and one that
    // declares it must supply one fails closed without it.
    if (COMPOSITE_METHODS.has(shot.method) || generation.fidelityRequired || generation.productReference) {
      if (generation.productReference && generation.mask) {
        fidelity = await fidelityReport(generation.productReference, generation.image, generation.mask, {
          kind: qcKindForSpec(spec),
          ...(generation.fidelityErodePx !== undefined ? { erodePx: generation.fidelityErodePx } : {}),
        });
      } else {
        fidelityInputsMissing = true;
      }
    }
    const fidelityOk = fidelityInputsMissing ? false : (fidelity?.pass ?? true);

    let judged: LlmCall<QCVerdict>;
    try {
      judged = await llmJson<QCVerdict>(
        deps.ai,
        "qc",
        QCVerdict,
        {
          shot: { id: shot.id, type: shot.type, scene: shot.scene },
          deterministic: {
            pixel: { pass: pixel.pass, checks: pixel.checks },
            fidelity: fidelity
              ? { pass: fidelity.pass, meanDeltaE: fidelity.meanDeltaE, exactByteShare: fidelity.exactByteShare }
              : null,
          },
          attempt,
        },
        { jobId: ctx.jobId, workspaceId: ctx.workspaceId, stepId: `${shot.id}:qc:${attempt}` },
        undefined,
        QCVerdict,
      );
    } catch (err) {
      // A cap reached at the judge ends this shot, not the whole pack.
      if (isSpendCapBlock(err)) {
        return unusable("Spend cap reached before this shot could be checked.");
      }
      throw err;
    }
    costMicros += judged.costMicros;
    const verdict = judged.value ?? deterministicVerdict(pixel, fidelity);
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

    const digitalSource = digitalSourceFor(shot.method, ctx.mode);
    const measured: MeasuredCompliance = {
      fillPct: pixel.fillRatio !== null ? Math.round(pixel.fillRatio * 100) : null,
      background:
        pixel.pass && spec.background?.rgb
          ? ([spec.background.rgb[0], spec.background.rgb[1], spec.background.rgb[2]] as [
              number,
              number,
              number,
            ])
          : null,
    };
    // Spend cap: accepted work stands, but no further attempts are funded.
    let decision = planRetry(attempt, effective);
    if (
      decision.action !== "accept" &&
      deps.assetCostCapMicros !== undefined &&
      costMicros >= deps.assetCostCapMicros
    ) {
      decision = { action: "needs_review" };
    }
    if (decision.action === "accept") {
      const outcome: ShotOutcome = {
        shotId: shot.id,
        shotType: shot.type,
        specId,
        credits: shot.credits,
        status: "passed",
        attempts: attempt,
        usedFallbackProvider: useFallbackProvider,
        costMicros,
        verdict: effective,
        pixelPass: pixel.pass,
        fidelityPass: fidelityInputsMissing ? false : fidelity ? fidelity.pass : null,
        digitalSource,
        measured,
        packAsset: {
          specId,
          buffer: generation.encoded.buffer,
          format: generation.encoded.format,
          raw: generation.image,
          mask: generation.mask ?? undefined,
          sku: ctx.sku,
          seoSlug: ctx.seoSlug,
          edgeMarginPx: 2,
          ref: shot.id,
          digitalSource,
        },
      };
      await deps.store.saveAsset(toStoredAsset(outcome, ctx));
      return outcome;
    }
    if (decision.action === "needs_review") {
      const outcome: ShotOutcome = {
        shotId: shot.id,
        shotType: shot.type,
        specId,
        credits: shot.credits,
        status: "needs_review",
        attempts: attempt,
        usedFallbackProvider: useFallbackProvider,
        costMicros,
        verdict: effective,
        pixelPass: pixel.pass,
        fidelityPass: fidelityInputsMissing ? false : fidelity ? fidelity.pass : null,
        digitalSource,
        measured,
      };
      await deps.store.saveAsset(toStoredAsset(outcome, ctx));
      return outcome;
    }
    if (decision.action === "fallback_provider") {
      useFallbackProvider = true;
    }
    attempt = decision.nextAttempt;
    repairHint = decision.repairHint;
  }
}

function toStoredAsset(outcome: ShotOutcome, ctx: ShotContext): StoredAsset {
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
    encoded: outcome.packAsset ? { buffer: outcome.packAsset.buffer, format: outcome.packAsset.format ?? "png" } : undefined,
  };
}

/** Wraps seller text in the untrusted data tags the seeded system prompts
 * reference (plan 4.5.3): user text is data, never instructions. */
export function wrapUserDescription(description: string | undefined | null): string | null {
  if (!description || description.length === 0) {
    return null;
  }
  return `<user_description>${description}</user_description>`;
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

/** An LLM shot list is usable only when it validates, every shot targets a
 * known channel spec, every shot draws from one of this job's uploaded
 * photos (when the allowed media ids are given), and the plan fits the
 * credit budget. */
export function validateLlmShotList(
  raw: unknown,
  creditBudget: number,
  allowedMediaIds?: readonly string[],
): ShotList | null {
  const parsed = ShotList.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const shots = parsed.data.shots;
  if (allowedMediaIds && allowedMediaIds.length > 0) {
    const allowed = new Set(allowedMediaIds);
    if (shots.some((s) => !allowed.has(s.sourceMediaId))) {
      return null;
    }
  }
  if (shots.some((s) => s.channels.length === 0 || !hasSpec(s.channels[0]))) {
    return null;
  }
  const total = shots.reduce((sum, s) => sum + s.credits, 0);
  if (total > creditBudget) {
    return null;
  }
  return parsed.data;
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

    // Plan shots: LLM planner recipe first, deterministic planShots when the
    // response is schema invalid. Concept mode drops marketplace channels
    // before planning; the exclusion is structural, not a pricing convention.
    await advance(transition(state, "analysis_done"));
    const conceptExcluded =
      input.mode === "concept" ? input.channels.filter((c) => isMarketplaceChannel(c)) : [];
    const effectiveChannels = input.channels.filter((c) => !conceptExcluded.includes(c));
    const planOptions: PlanOptions = {
      channels: effectiveChannels,
      tier: input.tier,
      creditBudget: input.creditBudget,
      hasBoxContents: input.hasBoxContents,
      hasComparisonFacts: input.hasComparisonFacts,
      hasVideoSource: input.hasVideoSource,
      primaryMediaId: input.images[0]?.mediaId,
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
    let shotList = validateLlmShotList(
      planned.raw,
      input.creditBudget,
      input.images.map((image) => image.mediaId),
    );
    if (shotList) {
      plannerSource = "llm";
    } else {
      shotList = planShots(profile, planOptions);
      plannerSource = "deterministic";
    }
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
    await advance(transition(state, "plan_ready"));
    const ctx: ShotContext = {
      jobId: input.jobId,
      workspaceId: input.workspaceId,
      sku: input.sku,
      seoSlug: input.seoSlug,
      mode: input.mode ?? "listing",
      brandColors: input.brandColors,
    };
    // Pack level spend cap: a shared tracker gates every generation attempt
    // across the parallel fan out, so a runaway pack stops mid flight.
    let fanOutDeps = deps;
    if (deps.packCostCapMicros !== undefined) {
      const cap = deps.packCostCapMicros;
      const baseCost = costMicros;
      let generatedCostMicros = 0;
      const inner = deps.generator;
      fanOutDeps = {
        ...deps,
        generator: {
          generate: async (args) => {
            if (baseCost + generatedCostMicros >= cap) {
              throw new Error("Pack cost cap reached before all shots finished");
            }
            const generation = await inner.generate(args);
            generatedCostMicros += generation.costMicros;
            return generation;
          },
        },
      };
    }
    const runShots =
      deps.runShots ??
      ((shots: Shot[], c: ShotContext) => Promise.all(shots.map((s) => runShot(s, c, fanOutDeps))));
    const outcomes = await runShots(shotList.shots, ctx);
    costMicros += outcomes.reduce((sum, o) => sum + o.costMicros, 0);

    // QC accounting, part one: release every failed shot now. Passing shots
    // stay held until their files are delivered (below), so a pack that
    // never ships is never charged.
    await advance(transition(state, "shots_generated"));
    const passing = outcomes.filter((o) => o.status === "passed");
    for (const outcome of outcomes) {
      if (outcome.status !== "passed") {
        needsReview += 1;
        await applyLedger(ledger.releaseForFailedShot(outcome.shotId, outcome.credits));
      }
    }

    // Packaging.
    await advance(transition(state, "qc_done"));
    const packAssets = outcomes
      .filter((o) => o.status === "passed" && o.packAsset)
      .map((o) => o.packAsset as PackAsset);
    const families = [...new Set(packAssets.map((a) => channelOf(a.specId)))];
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
    // passing asset. The heartbeat keeps the reconciler off the job while
    // the charges land.
    await store.heartbeat?.(input.jobId);
    for (const outcome of passing) {
      passed += 1;
      await applyLedger(ledger.chargeForPassingAsset(outcome.shotId, outcome.credits));
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
