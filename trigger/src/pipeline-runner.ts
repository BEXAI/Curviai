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
  type CostMeter,
  type ProviderRegistry,
  type RoutingTable,
} from "@curvi/ai";
import {
  buildPack,
  channelOf,
  fidelityReport,
  pixelChecks,
  planRetry,
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
import { JobLedgerPlan, transition, type JobState, type LedgerAction } from "./state";

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
  setJobState(jobId: string, state: JobState, meta?: Record<string, unknown>): Promise<void>;
  appendLedger(entry: JobLedgerEntry): Promise<void>;
  saveAsset(asset: StoredAsset): Promise<void>;
  savePack(pack: StoredPack): Promise<void>;
}

export class InMemoryJobStore implements JobStore {
  readonly states: Array<{ jobId: string; state: JobState; meta?: Record<string, unknown> }> = [];
  readonly ledger: JobLedgerEntry[] = [];
  readonly assets: StoredAsset[] = [];
  readonly packs: StoredPack[] = [];

  async setJobState(jobId: string, state: JobState, meta?: Record<string, unknown>): Promise<void> {
    this.states.push({ jobId, state, meta });
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
}

export interface ShotGenerateArgs {
  shot: Shot;
  attempt: number;
  repairHint?: string;
  /** True on the extra attempt after 3 failures (plan 5.6 retry policy). */
  useFallbackProvider: boolean;
  jobId: string;
  workspaceId: string;
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
  /** Fan out override: the Trigger.dev wrapper points this at the
   * generate-shot subtask. Defaults to Promise.all over runShot. */
  runShots?: (shots: Shot[], ctx: ShotContext) => Promise<ShotOutcome[]>;
  /** Where buildPack writes zips. A temp dir when omitted. */
  packOutDir?: string;
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
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

interface LlmCall<T> {
  value: T | null;
  raw: unknown;
  costMicros: number;
}

/** Accepts either a raw JSON object (mock and demo providers) or an
 * Anthropic adapter shaped output with toolUse or text. */
function extractJsonOutput(output: unknown): unknown {
  if (output && typeof output === "object") {
    const o = output as { toolUse?: { input?: unknown } | null; text?: string | null };
    if (o.toolUse && o.toolUse.input !== undefined) {
      return o.toolUse.input;
    }
    if (typeof o.text === "string") {
      try {
        return JSON.parse(o.text);
      } catch {
        return o.text;
      }
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
): Promise<LlmCall<T>> {
  const recipe = activeRecipe(stage);
  const input: LlmTaskInput = {
    system: recipe.body.system,
    model: recipe.model,
    messages: [{ role: "user", content: JSON.stringify(payload) }],
  };
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

  for (;;) {
    const generation = await deps.generator.generate({
      shot,
      attempt,
      repairHint,
      useFallbackProvider,
      jobId: ctx.jobId,
      workspaceId: ctx.workspaceId,
    });
    costMicros += generation.costMicros;

    const pixel = await pixelChecks(generation.image, generation.mask, spec, {
      encoded: { bytes: generation.encoded.buffer.length, format: generation.encoded.format },
      edgeMarginPx: 2,
    });

    // Rule 3 gate, fail closed: a composite or edit method that cannot prove
    // its paste back (no product reference or no mask) never passes.
    let fidelity: FidelityReport | null = null;
    let fidelityInputsMissing = false;
    if (COMPOSITE_METHODS.has(shot.method)) {
      if (generation.productReference && generation.mask) {
        fidelity = await fidelityReport(generation.productReference, generation.image, generation.mask, {
          kind: qcKindForSpec(spec),
        });
      } else {
        fidelityInputsMissing = true;
      }
    }
    const fidelityOk = fidelityInputsMissing ? false : (fidelity?.pass ?? true);

    const judged = await llmJson<QCVerdict>(
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
    );
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
    const decision = planRetry(attempt, effective);
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
  };
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
 * known channel spec, and the plan fits the credit budget. */
export function validateLlmShotList(raw: unknown, creditBudget: number): ShotList | null {
  const parsed = ShotList.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const shots = parsed.data.shots;
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

  await store.setJobState(input.jobId, state);
  await applyLedger(ledger.reserveOnQueue(input.creditBudget));

  try {
    // Intake and analyze.
    state = transition(state, "start_analysis");
    await store.setJobState(input.jobId, state);
    const intake = await llmJson<IntakeResult>(
      deps.ai,
      "intake",
      IntakeResult,
      { images: input.images, userDescription: input.userDescription ?? null },
      { jobId: input.jobId, workspaceId: input.workspaceId, stepId: "intake" },
    );
    costMicros += intake.costMicros;
    if (!intake.value) {
      throw new Error("Intake response failed schema validation");
    }
    if (!intake.value.images.some((img) => img.sellableProduct)) {
      throw new Error("Intake found no sellable product in the uploaded images");
    }

    const analysis = await llmJson<ProductProfile>(
      deps.ai,
      "analyze",
      ProductProfile,
      { images: input.images, userDescription: input.userDescription ?? null },
      { jobId: input.jobId, workspaceId: input.workspaceId, stepId: "analyze" },
    );
    costMicros += analysis.costMicros;
    if (!analysis.value) {
      throw new Error("Product analysis response failed schema validation");
    }
    const profile = analysis.value;

    // Plan shots: LLM planner recipe first, deterministic planShots when the
    // response is schema invalid. Concept mode drops marketplace channels
    // before planning; the exclusion is structural, not a pricing convention.
    state = transition(state, "analysis_done");
    await store.setJobState(input.jobId, state);
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
    );
    costMicros += planned.costMicros;
    let shotList = validateLlmShotList(planned.raw, input.creditBudget);
    if (shotList) {
      plannerSource = "llm";
    } else {
      shotList = planShots(profile, planOptions);
      plannerSource = "deterministic";
    }
    plannedShots = shotList.shots.length;
    skipped = [
      ...conceptExcluded.map((channel) => ({
        type: channel,
        reason: "concept mode excludes marketplace channels",
      })),
      ...shotList.skipped,
    ];

    // Fan out per shot generation, each shot carrying its own QC retry loop.
    state = transition(state, "plan_ready");
    await store.setJobState(input.jobId, state);
    const ctx: ShotContext = {
      jobId: input.jobId,
      workspaceId: input.workspaceId,
      sku: input.sku,
      seoSlug: input.seoSlug,
      mode: input.mode ?? "listing",
    };
    const runShots =
      deps.runShots ?? ((shots: Shot[], c: ShotContext) => Promise.all(shots.map((s) => runShot(s, c, deps))));
    const outcomes = await runShots(shotList.shots, ctx);
    costMicros += outcomes.reduce((sum, o) => sum + o.costMicros, 0);

    // QC accounting: charge per passing asset, release per failed shot.
    state = transition(state, "shots_generated");
    await store.setJobState(input.jobId, state);
    for (const outcome of outcomes) {
      if (outcome.status === "passed") {
        passed += 1;
        await applyLedger(ledger.chargeForPassingAsset(outcome.shotId, outcome.credits));
      } else {
        needsReview += 1;
        await applyLedger(ledger.releaseForFailedShot(outcome.shotId, outcome.credits));
      }
    }

    // Packaging.
    state = transition(state, "qc_done");
    await store.setJobState(input.jobId, state);
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

    state = transition(state, "packaged");
    await applyLedger(ledger.releaseUnusedOnCompletion());
    await store.setJobState(input.jobId, state, { passed, needsReview });

    return {
      jobId: input.jobId,
      state: "done",
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
    };
  } catch (err) {
    const message =
      err instanceof AllProvidersFailedError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    state = transition(state, "fail");
    await applyLedger(ledger.releaseRemainderOnFailure("failed"));
    await store.setJobState(input.jobId, state, { error: message });
    return {
      jobId: input.jobId,
      state: "failed",
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
      error: message,
    };
  }
}
