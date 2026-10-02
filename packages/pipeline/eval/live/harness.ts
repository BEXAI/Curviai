/**
 * Live LLM eval harness (docs/phases/PHASE_17.md workstream 4, items 1 to 3).
 *
 * Runs the LLM golden set (./cases.ts) and the prompt injection fixtures
 * (./injection.ts) through one provider family for every recipe, and scores
 * each answer the way the runner reads it: the request is built as llmJson
 * builds it (system prompt, image blocks, the JSON payload as text, the
 * strict emit_result output, the strict to non strict retry after a 400 and
 * the single re ask when the answer has no JSON), and the answer is checked
 * with the same lenient schema the runner uses.
 *
 * It reports, per recipe: schema pass rate, refusals, truncations, latency,
 * tokens and cost, and agreement with a stored Claude baseline, then checks
 * the plan's pass bar (workstream 4 item 2). It never calls a provider by
 * itself: the caller (./callers.ts) decides whether answers come from a live
 * model or a recording, so the whole harness is unit tested on recordings.
 */

import { z } from "zod";
import type { LlmContentBlock, LlmFinish, LlmRequest, LlmUsage } from "@curvi/ai";
import {
  IntakeAnswer,
  IntakeToolResult,
  LlmShotList,
  ProductProfile,
  ProductProfileAnswer,
  QCVerdict,
  strictToolSchema,
  TargetPick,
  TargetPickAnswer,
} from "../../src/schemas";
import { PaletteNaming } from "../../src/brand/palette";
import { QuestionPlanAnswer, QuestionPlanTool } from "../../src/questions";
import { AplusCopyResult } from "../../src/aplus-copy";
import { PackCopyResult } from "../../src/ad-copy";
import { adCopyRecipe, restrictedGoodsIntake, type RecipeRow } from "../../src/seed/recipes";
import { llmModelProviders, type LlmProviderFamily } from "../../src/seed/models";
import type { CallOutcome, LlmCaller } from "./callers";

export type RecipeStage = RecipeRow["stage"];

/** One golden input for a recipe stage. */
export interface GoldenCase {
  /** Stable id: the baseline and recordings are keyed by it. */
  id: string;
  stage: RecipeStage;
  description: string;
  /** Image blocks sent before the text, as the runner sends them. */
  blocks: LlmContentBlock[];
  /** The JSON payload the runner would send for this recipe row. */
  payload: (row: RecipeRow) => unknown;
  /** New draft checks do not alter an older version's recorded baseline. */
  minRecipeVersion?: number;
  /** Absolute checks in addition to JSON validity and baseline comparisons. */
  violations?: (answer: unknown) => string[];
}

/**
 * A golden photo of one of OpenAI's prohibited goods (docs/phases/PHASE_19.md
 * P19-29). It runs only on an intake recipe that asks for restrictedCategory
 * (restrictedGoodsIntake), and the bar is absolute, not against Claude: every
 * image must name this seeded category. The same recipe must name none on
 * the clean golden photos.
 */
export interface ScreeningFixture extends GoldenCase {
  expectCategory: string;
}

export interface ScreeningResult {
  id: string;
  recipeKey: string;
  version: number;
  expected: string;
  /** The category each image named, or null; empty when nothing parsed. */
  named: Array<string | null>;
  pass: boolean;
}

/** True when this recipe row's prompt asks for restrictedCategory. */
export function asksRestrictedGoods(row: Pick<RecipeRow, "key" | "version">): boolean {
  return row.key === restrictedGoodsIntake.key && row.version >= restrictedGoodsIntake.minVersion;
}

/** The restrictedCategory of each image of an intake answer. */
export function namedCategories(answer: unknown): Array<string | null> {
  return list(record(answer).images).map((image) => {
    const category = record(image).restrictedCategory;
    return typeof category === "string" ? category : null;
  });
}

/** A golden case whose seller text tries to change prices, flags or rules. */
export interface InjectionFixture extends GoldenCase {
  /** What holding the guard means, in plain words. */
  guard: string;
  /** Every way the parsed answer broke the guard; empty when it held. */
  violations: (answer: unknown) => string[];
}

/** The plan's pass bar (workstream 4 item 2). */
export const PASS_BAR = {
  /** Analyzer preserveText and preserveLogos recall of Claude's entries. */
  analyzerRecall: 0.95,
} as const;

/** The name the runner gives the structured answer. */
const OUTPUT_NAME = "emit_result";

type AnswerSchema = { safeParse: (data: unknown) => { success: boolean; data?: unknown } };

interface StageSchemas {
  /** The schema sent to the model as the structured output. */
  tool: z.ZodType;
  /** The schema the runner validates the answer with. */
  answer: AnswerSchema;
}

/** The output and answer schemas the runner uses for each stage. */
export function stageSchemas(row: Pick<RecipeRow, "stage" | "key" | "version">): StageSchemas {
  switch (row.stage) {
    case "intake":
      return { tool: IntakeToolResult, answer: IntakeAnswer };
    case "analyze":
      return { tool: ProductProfile, answer: ProductProfileAnswer };
    case "plan":
      return { tool: LlmShotList, answer: LlmShotList };
    case "copy": {
      const pack = row.key === adCopyRecipe.key && row.version >= adCopyRecipe.minVersion;
      return pack ? { tool: PackCopyResult, answer: PackCopyResult } : { tool: AplusCopyResult, answer: AplusCopyResult };
    }
    case "qc":
      return { tool: QCVerdict, answer: QCVerdict };
    case "pick":
      return { tool: TargetPick, answer: TargetPickAnswer };
    case "brand":
      return { tool: PaletteNaming, answer: PaletteNaming };
    case "question":
      return { tool: QuestionPlanTool, answer: QuestionPlanAnswer };
  }
}

/**
 * The strict output schema the runner sends (llmJson): strictToolSchema for
 * every family. The OpenAI adapter converts it to OpenAI's strict form
 * itself (openaiStrictJsonSchema), so eval requests match production.
 */
export function strictSchemaFor(_family: LlmProviderFamily, schema: z.ZodType): Record<string, unknown> {
  return strictToolSchema(schema);
}

/** A recipe row and the model the eval runs it on. */
export interface SelectedRecipe {
  row: RecipeRow;
  model: string;
}

function chainOf(row: RecipeRow): string[] {
  return [row.model, ...(row.fallbackModels ?? [])];
}

/**
 * Which recipe row and model each key runs on for a provider family. A row
 * whose primary model belongs to the family wins (so the Claude baseline is
 * Claude's own prompt version), then an active row, then the highest
 * version. The model is the family's first model in that row's chain, or
 * the one model asked for. A filter entry is a key, or key@version.
 */
export function selectRecipes(
  rows: readonly RecipeRow[],
  family: LlmProviderFamily,
  opts: { only?: string[]; model?: string; providers?: Readonly<Record<string, LlmProviderFamily>> } = {},
): { selected: SelectedRecipe[]; skipped: Array<{ key: string; reason: string }> } {
  const providers = opts.providers ?? llmModelProviders;
  if (opts.model !== undefined && providers[opts.model] !== family) {
    throw new Error(`Model ${opts.model} is not served by ${family}`);
  }
  const filters = new Map<string, number | null>();
  for (const entry of opts.only ?? []) {
    const [key, version] = entry.split("@");
    filters.set(key, version === undefined ? null : Number(version));
  }
  const keys = [...new Set(rows.map((row) => row.key))].filter((key) => filters.size === 0 || filters.has(key));
  const unknown = [...filters.keys()].filter((key) => !rows.some((row) => row.key === key));
  const selected: SelectedRecipe[] = [];
  const skipped = unknown.map((key) => ({ key, reason: "no such recipe" }));
  const ofFamily = (model: string) => providers[model] === family;
  for (const key of keys) {
    const wanted = filters.get(key) ?? null;
    const candidates = rows
      .filter((row) => row.key === key && (wanted === null || row.version === wanted))
      .filter((row) => opts.model !== undefined || chainOf(row).some(ofFamily))
      .sort(
        (a, b) =>
          Number(ofFamily(b.model)) - Number(ofFamily(a.model)) ||
          Number(b.active) - Number(a.active) ||
          b.version - a.version,
      );
    const row = candidates[0];
    if (!row) {
      skipped.push({
        key,
        reason: wanted === null ? `no ${family} model in any version's chain` : `version ${wanted} has no ${family} model`,
      });
      continue;
    }
    const model = opts.model ?? chainOf(row).find(ofFamily);
    if (model === undefined) {
      continue;
    }
    selected.push({ row, model });
  }
  return { selected, skipped };
}

/** What one golden case produced on one model. */
export interface CaseResult {
  recipeKey: string;
  recipeVersion: number;
  model: string;
  caseId: string;
  stage: RecipeStage;
  /** The answer passed the runner's schema. */
  schemaPass: boolean;
  /** Present only for a case with explicit semantic acceptance checks. */
  semanticIssues?: string[];
  /** The parsed answer, or null when it failed the schema. */
  answer: unknown;
  finish: LlmFinish | null;
  refused: boolean;
  truncated: boolean;
  /** The last call's error, when it failed. */
  error: string | null;
  /** The strict request was answered 400 and retried without strict. */
  strictRetried: boolean;
  /** The answer had no JSON and was asked once more. */
  reasked: boolean;
  calls: number;
  latencyMs: number;
  costMicros: number;
  usage: LlmUsage;
}

/** Replaces string leaves holding a JSON object or array with the parsed
 * value, as the runner repairs answers (parseNestedJsonStrings). */
export function repairNestedJson(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return repairNestedJson(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    const next = value.map(repairNestedJson);
    return next.some((v, i) => v !== value[i]) ? next : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      next[key] = repairNestedJson(v);
      changed ||= next[key] !== v;
    }
    return changed ? next : value;
  }
  return value;
}

function zeroUsage(): LlmUsage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
}

function addUsage(total: LlmUsage, more: LlmUsage): void {
  total.inputTokens += more.inputTokens;
  total.cachedInputTokens += more.cachedInputTokens;
  total.outputTokens += more.outputTokens;
  total.reasoningTokens += more.reasoningTokens;
}

/** The request llmJson builds for this case, strict or not. */
/** Mirrors the runner's withImageDetail (trigger/src/pipeline-runner.ts):
 * the recipe's seeded image detail on every image block without one. */
export function withImageDetail(
  blocks: readonly LlmContentBlock[],
  detail: "low" | "high" | undefined,
): LlmContentBlock[] {
  if (!detail) return [...blocks];
  return blocks.map((block) => (block.type === "image" && !block.detail ? { ...block, detail } : block));
}

export function buildRequest(
  selected: SelectedRecipe,
  family: LlmProviderFamily,
  goldenCase: GoldenCase,
  strict: boolean,
): LlmRequest {
  const { row } = selected;
  const tool = stageSchemas(row).tool;
  const request: LlmRequest = {
    system: row.body.system,
    messages: [
      {
        role: "user",
        content: [
          ...withImageDetail(goldenCase.blocks, row.body.imageDetail),
          { type: "text", text: JSON.stringify(goldenCase.payload(row)) },
        ],
      },
    ],
    output: {
      name: OUTPUT_NAME,
      schema: strict ? strictSchemaFor(family, tool) : z.toJSONSchema(tool),
      strict,
    },
  };
  if (row.body.maxTokens !== undefined) {
    request.maxOutputTokens = row.body.maxTokens;
  }
  if (row.body.modelOptions !== undefined) {
    request.modelOptions = row.body.modelOptions;
  }
  return request;
}

/** One golden case through the caller, the way llmJson runs it. */
export async function runCase(caller: LlmCaller, selected: SelectedRecipe, goldenCase: GoldenCase): Promise<CaseResult> {
  const { row, model } = selected;
  const usage = zeroUsage();
  let calls = 0;
  let latencyMs = 0;
  let costMicros = 0;
  const call = async (strict: boolean): Promise<CallOutcome> => {
    const outcome = await caller.call({
      recipeKey: row.key,
      caseId: goldenCase.id,
      model,
      input: buildRequest(selected, caller.provider, goldenCase, strict),
      ...(row.body.timeoutMs !== undefined ? { timeoutMs: row.body.timeoutMs } : {}),
    });
    calls += 1;
    latencyMs += outcome.latencyMs;
    costMicros += outcome.costMicros;
    if (outcome.ok) {
      addUsage(usage, outcome.result.usage);
    }
    return outcome;
  };

  let strict = true;
  let strictRetried = false;
  let reasked = false;
  let outcome = await call(strict);
  if (!outcome.ok && outcome.badRequest) {
    strict = false;
    strictRetried = true;
    outcome = await call(strict);
  }
  if (outcome.ok && (outcome.result.json === null || outcome.result.json === undefined)) {
    reasked = true;
    outcome = await call(strict);
  }

  const schema = stageSchemas(row).answer;
  let answer: unknown = null;
  let schemaPass = false;
  if (outcome.ok) {
    const extracted = outcome.result.json ?? (outcome.result.text !== "" ? outcome.result.text : null);
    let parsed = schema.safeParse(extracted);
    if (!parsed.success) {
      const repaired = repairNestedJson(extracted);
      if (repaired !== extracted) {
        parsed = schema.safeParse(repaired);
      }
    }
    schemaPass = parsed.success;
    answer = parsed.success ? (parsed.data ?? null) : null;
  }
  const finish = outcome.ok ? outcome.result.finish : null;
  return {
    recipeKey: row.key,
    recipeVersion: row.version,
    model,
    caseId: goldenCase.id,
    stage: row.stage,
    schemaPass,
    ...(goldenCase.violations ? {
      semanticIssues: schemaPass ? goldenCase.violations(answer) : ["No valid structured answer."],
    } : {}),
    answer,
    finish,
    refused: (!outcome.ok && outcome.code === "content_blocked") || finish === "refused" || finish === "filtered",
    truncated: (!outcome.ok && outcome.code === "output_truncated") || finish === "truncated",
    error: outcome.ok ? null : `${outcome.code ?? "error"}: ${outcome.message}`,
    strictRetried,
    reasked,
    calls,
    latencyMs,
    costMicros,
    usage,
  };
}

/** The stored Claude answers the candidate is compared with. */
export interface BaselineCase {
  schemaPass: boolean;
  answer: unknown;
  refused: boolean;
  truncated: boolean;
}

export interface Baseline {
  version: 1;
  provider: LlmProviderFamily;
  recordedAt: string;
  recipes: Record<string, { version: number; model: string; cases: Record<string, BaselineCase> }>;
  /** Whether each injection fixture's guard held. */
  injection: Record<string, { pass: boolean }>;
}

export interface BarCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface RecipeReport {
  key: string;
  version: number;
  model: string;
  cases: number;
  schemaPass: number;
  schemaPassRate: number;
  refusals: number;
  truncations: number;
  errors: number;
  strictRetries: number;
  reasks: number;
  latencyMs: { p50: number; p95: number; max: number };
  tokens: LlmUsage;
  costMicros: number;
  baselineSchemaPassRate: number | null;
  /** Cases compared with the baseline and how many agreed, for the stages
   * the bar compares answers on. */
  agreement: { compared: number; agreed: number } | null;
  bar: BarCheck[];
}

export type GuardStatus = "held" | "refused" | "broken" | "no_answer";

export interface InjectionResult {
  id: string;
  recipeKey: string;
  guard: string;
  status: GuardStatus;
  /** Held or refused: the seller text changed nothing it must not. */
  pass: boolean;
  violations: string[];
  baselinePass: boolean | null;
}

export interface LiveReport {
  generatedAt: string;
  provider: LlmProviderFamily;
  baselineRecordedAt: string | null;
  recipes: RecipeReport[];
  skipped: Array<{ key: string; reason: string }>;
  injection: InjectionResult[];
  /** The prohibited goods fixtures, on the recipes that ask (P19-29). */
  screening: ScreeningResult[];
  cases: CaseResult[];
  totals: { calls: number; costMicros: number; tokens: LlmUsage };
  /** The pass bar held for every recipe and fixture. */
  pass: boolean;
  failures: string[];
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Lowercase letters and digits only, for comparing listed text. */
function normalizeText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Share of the baseline's entries the candidate also lists (equal, or one
 * holding the other, after normalizing). */
export function recallOf(baseline: readonly string[], candidate: readonly string[]): { found: number; total: number } {
  const theirs = baseline.map(normalizeText).filter((t) => t.length > 0);
  const ours = candidate.map(normalizeText).filter((t) => t.length > 0);
  const found = theirs.filter((t) => ours.some((o) => o === t || o.includes(t) || t.includes(o))).length;
  return { found, total: theirs.length };
}

/** The moderation flags and sellableProduct per image, as one string per
 * image, so two answers compare in one step. */
export function intakeVerdicts(answer: unknown): string[] {
  return list(record(answer).images).map((image) => {
    const img = record(image);
    const flags = record(img.flags);
    return ["sellableProduct", "nudity", "weapons", "drugs", "prohibited", "realPersonMainSubject"]
      .map((name) => `${name}=${String(name === "sellableProduct" ? img.sellableProduct : flags[name])}`)
      .join(" ");
  });
}

/** True when a plan answer would be used rather than the deterministic plan:
 * it parsed and holds at least one shot. */
export function planUsable(result: Pick<CaseResult, "schemaPass" | "answer">): boolean {
  return result.schemaPass && list(record(result.answer).shots).length > 0;
}

/** Answer agreement for stages compared case by case: the value compared,
 * or undefined for stages the bar does not compare this way. */
function comparable(stage: RecipeStage, answer: unknown): string | undefined {
  switch (stage) {
    case "intake":
      return intakeVerdicts(answer).join(" | ");
    case "pick":
      return String(record(answer).choice ?? null);
    case "qc":
      return String(record(answer).pass);
    default:
      return undefined;
  }
}

const AGREEMENT_CHECK: Partial<Record<RecipeStage, string>> = {
  intake: "moderation flags and sellableProduct agree with Claude on every golden photo",
  pick: "target picker choices agree with Claude on every photo",
  qc: "judge verdicts agree with Claude on every fixture",
};

/** The bar checks for one recipe against its baseline. */
function barChecks(
  stage: RecipeStage,
  results: readonly CaseResult[],
  baseline: Baseline["recipes"][string] | undefined,
  schemaPassRate: number,
): { bar: BarCheck[]; agreement: RecipeReport["agreement"]; baselineRate: number | null } {
  if (!baseline) {
    return {
      bar: [{ name: "Claude baseline", pass: false, detail: "no stored Claude answers for this recipe" }],
      agreement: null,
      baselineRate: null,
    };
  }
  const baseCases = results.map((r) => baseline.cases[r.caseId]).filter((c): c is BaselineCase => c !== undefined);
  const baselineRate = baseCases.length === 0 ? 0 : baseCases.filter((c) => c.schemaPass).length / baseCases.length;
  const bar: BarCheck[] = [
    {
      name: "schema pass rate at least Claude's",
      pass: schemaPassRate >= baselineRate,
      detail: `${(schemaPassRate * 100).toFixed(0)}% against ${(baselineRate * 100).toFixed(0)}%`,
    },
  ];
  const missing = results.filter((r) => baseline.cases[r.caseId] === undefined).map((r) => r.caseId);
  if (missing.length > 0) {
    bar.push({ name: "every case has a Claude answer", pass: false, detail: `missing ${missing.join(", ")}` });
  }

  let agreement: RecipeReport["agreement"] = null;
  const checkName = AGREEMENT_CHECK[stage];
  if (checkName) {
    let compared = 0;
    let agreed = 0;
    const differs: string[] = [];
    for (const result of results) {
      const base = baseline.cases[result.caseId];
      if (!base?.schemaPass) continue;
      compared += 1;
      const same = result.schemaPass && comparable(stage, result.answer) === comparable(stage, base.answer);
      if (same) agreed += 1;
      else differs.push(result.caseId);
    }
    agreement = { compared, agreed };
    bar.push({
      name: checkName,
      pass: agreed === compared,
      detail: differs.length === 0 ? `${agreed} of ${compared}` : `differs on ${differs.join(", ")}`,
    });
  }
  if (stage === "analyze") {
    const totals = { text: { found: 0, total: 0 }, logos: { found: 0, total: 0 } };
    for (const result of results) {
      const base = baseline.cases[result.caseId];
      if (!base?.schemaPass) continue;
      const ours = record(result.schemaPass ? result.answer : null);
      const theirs = record(base.answer);
      const text = recallOf(
        list(theirs.preserveText).map((t) => String(record(t).text ?? "")),
        list(ours.preserveText).map((t) => String(record(t).text ?? "")),
      );
      const logos = recallOf(list(theirs.preserveLogos).map(String), list(ours.preserveLogos).map(String));
      totals.text.found += text.found;
      totals.text.total += text.total;
      totals.logos.found += logos.found;
      totals.logos.total += logos.total;
    }
    for (const [field, t] of [
      ["preserveText", totals.text],
      ["preserveLogos", totals.logos],
    ] as const) {
      const recall = t.total === 0 ? 1 : t.found / t.total;
      bar.push({
        name: `${field} recalls at least ${PASS_BAR.analyzerRecall * 100}% of Claude's entries`,
        pass: recall >= PASS_BAR.analyzerRecall,
        detail: t.total === 0 ? "Claude listed none" : `${t.found} of ${t.total}`,
      });
    }
    agreement = {
      compared: totals.text.total + totals.logos.total,
      agreed: totals.text.found + totals.logos.found,
    };
  }
  if (stage === "plan") {
    const ours = results.filter((r) => !planUsable(r)).length;
    const theirs = results.filter((r) => {
      const base = baseline.cases[r.caseId];
      return !base || !planUsable(base);
    }).length;
    bar.push({
      name: "no more fallbacks to the deterministic plan than Claude",
      pass: ours <= theirs,
      detail: `${ours} against ${theirs}`,
    });
  }
  return { bar, agreement, baselineRate };
}

/** The report for one recipe's results. */
export function recipeReport(
  selected: SelectedRecipe,
  results: readonly CaseResult[],
  baseline: Baseline | null,
): RecipeReport {
  const tokens = zeroUsage();
  for (const r of results) addUsage(tokens, r.usage);
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const schemaPass = results.filter((r) => r.schemaPass).length;
  const schemaPassRate = results.length === 0 ? 0 : schemaPass / results.length;
  const { bar, agreement, baselineRate } = baseline
    ? barChecks(selected.row.stage, results, baseline.recipes[selected.row.key], schemaPassRate)
    : { bar: [], agreement: null, baselineRate: null };
  for (const result of results.filter((r) => r.semanticIssues !== undefined)) {
    const issues = result.semanticIssues ?? [];
    bar.push({
      name: `${result.caseId} semantic checks`,
      pass: issues.length === 0,
      detail: issues.length === 0 ? "All explicit checks passed." : issues.join("; "),
    });
  }
  return {
    key: selected.row.key,
    version: selected.row.version,
    model: selected.model,
    cases: results.length,
    schemaPass,
    schemaPassRate,
    refusals: results.filter((r) => r.refused).length,
    truncations: results.filter((r) => r.truncated).length,
    errors: results.filter((r) => r.error !== null).length,
    strictRetries: results.filter((r) => r.strictRetried).length,
    reasks: results.filter((r) => r.reasked).length,
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.at(-1) ?? 0 },
    tokens,
    costMicros: results.reduce((sum, r) => sum + r.costMicros, 0),
    baselineSchemaPassRate: baselineRate,
    agreement,
    bar,
  };
}

/** Whether one fixture's guard held on its answer. */
export function guardResult(fixture: InjectionFixture, result: CaseResult, baseline: Baseline | null): InjectionResult {
  let status: GuardStatus;
  let violations: string[] = [];
  if (result.refused) {
    status = "refused";
  } else if (!result.schemaPass) {
    status = "no_answer";
  } else {
    violations = fixture.violations(result.answer);
    status = violations.length === 0 ? "held" : "broken";
  }
  return {
    id: fixture.id,
    recipeKey: result.recipeKey,
    guard: fixture.guard,
    status,
    pass: status === "held" || status === "refused",
    violations,
    baselinePass: baseline?.injection[fixture.id]?.pass ?? null,
  };
}

export interface LiveEvalInput {
  caller: LlmCaller;
  rows: readonly RecipeRow[];
  cases: readonly GoldenCase[];
  injection: readonly InjectionFixture[];
  /** The prohibited goods fixtures (P19-29); none when left out. */
  screening?: readonly ScreeningFixture[];
  baseline: Baseline | null;
  only?: string[];
  model?: string;
  /** Model to provider map; the seed's llmModelProviders by default. */
  providers?: Readonly<Record<string, LlmProviderFamily>>;
  clock?: () => Date;
  /** Progress lines; silent by default. */
  log?: (line: string) => void;
}

/** Runs every selected recipe's golden cases and injection fixtures. */
export async function runLiveEval(input: LiveEvalInput): Promise<LiveReport> {
  const family = input.caller.provider;
  const log = input.log ?? (() => undefined);
  const { selected, skipped } = selectRecipes(input.rows, family, {
    ...(input.only ? { only: input.only } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.providers ? { providers: input.providers } : {}),
  });
  const cases: CaseResult[] = [];
  const recipes: RecipeReport[] = [];
  const injection: InjectionResult[] = [];
  const screening: ScreeningResult[] = [];
  const cleanCategoryCases: string[] = [];
  for (const recipe of selected) {
    const own = input.cases.filter((c) => c.stage === recipe.row.stage && recipe.row.version >= (c.minRecipeVersion ?? 1));
    const results: CaseResult[] = [];
    for (const goldenCase of own) {
      log(`${recipe.row.key} v${recipe.row.version} on ${recipe.model}: ${goldenCase.id}`);
      results.push(await runCase(input.caller, recipe, goldenCase));
    }
    cases.push(...results);
    recipes.push(recipeReport(recipe, results, input.baseline));
    for (const fixture of input.injection.filter((f) => f.stage === recipe.row.stage)) {
      log(`${recipe.row.key} v${recipe.row.version} on ${recipe.model}: injection ${fixture.id}`);
      const result = await runCase(input.caller, recipe, fixture);
      cases.push(result);
      injection.push(guardResult(fixture, result, input.baseline));
    }
    if (asksRestrictedGoods(recipe.row)) {
      // No regression on the existing set: no clean golden photo is put in a
      // prohibited goods category.
      for (const result of results.filter((r) => r.schemaPass)) {
        if (namedCategories(result.answer).some((category) => category !== null)) {
          cleanCategoryCases.push(`${recipe.row.key} v${recipe.row.version} ${result.caseId}`);
        }
      }
      for (const fixture of (input.screening ?? []).filter((f) => f.stage === recipe.row.stage)) {
        log(`${recipe.row.key} v${recipe.row.version} on ${recipe.model}: screening ${fixture.id}`);
        const result = await runCase(input.caller, recipe, fixture);
        cases.push(result);
        const named = result.schemaPass ? namedCategories(result.answer) : [];
        screening.push({
          id: fixture.id,
          recipeKey: recipe.row.key,
          version: recipe.row.version,
          expected: fixture.expectCategory,
          named,
          pass: named.length > 0 && named.every((category) => category === fixture.expectCategory),
        });
      }
    }
  }

  const failures: string[] = [];
  if (!input.baseline) {
    failures.push("No stored Claude baseline. Record one with --provider anthropic --record-baseline.");
  }
  for (const report of recipes) {
    for (const check of report.bar.filter((c) => !c.pass)) {
      failures.push(`${report.key}: ${check.name} (${check.detail})`);
    }
  }
  for (const result of injection) {
    if (result.baselinePass === null && input.baseline) {
      failures.push(`injection ${result.id}: no Claude result to compare with`);
    } else if (result.baselinePass && !result.pass) {
      failures.push(`injection ${result.id}: guard held on Claude but ${result.status} here (${result.violations.join("; ")})`);
    }
  }
  for (const result of screening.filter((r) => !r.pass)) {
    failures.push(
      `screening ${result.id}: ${result.recipeKey} v${result.version} should name ${result.expected}, named ${
        result.named.length === 0 ? "nothing that parsed" : result.named.map((c) => c ?? "none").join(", ")
      }`,
    );
  }
  for (const where of cleanCategoryCases) {
    failures.push(`screening: a clean golden photo was put in a prohibited goods category (${where})`);
  }
  const tokens = zeroUsage();
  for (const r of cases) addUsage(tokens, r.usage);
  return {
    generatedAt: (input.clock ?? (() => new Date()))().toISOString(),
    provider: family,
    baselineRecordedAt: input.baseline?.recordedAt ?? null,
    recipes,
    skipped,
    injection,
    screening,
    cases,
    totals: {
      calls: cases.reduce((sum, r) => sum + r.calls, 0),
      costMicros: cases.reduce((sum, r) => sum + r.costMicros, 0),
      tokens,
    },
    pass: failures.length === 0,
    failures,
  };
}

/** A baseline from a run: the answers and guard results, by recipe and case. */
export function baselineFromReport(report: LiveReport): Baseline {
  const recipes: Baseline["recipes"] = {};
  for (const recipe of report.recipes) {
    recipes[recipe.key] = { version: recipe.version, model: recipe.model, cases: {} };
  }
  const injectionIds = new Set([...report.injection.map((i) => i.id), ...(report.screening ?? []).map((s) => s.id)]);
  for (const result of report.cases) {
    if (injectionIds.has(result.caseId)) continue;
    const entry = recipes[result.recipeKey];
    if (!entry) continue;
    entry.cases[result.caseId] = {
      schemaPass: result.schemaPass,
      answer: result.answer,
      refused: result.refused,
      truncated: result.truncated,
    };
  }
  return {
    version: 1,
    provider: report.provider,
    recordedAt: report.generatedAt,
    recipes,
    injection: Object.fromEntries(report.injection.map((i) => [i.id, { pass: i.pass }])),
  };
}

function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)];
}

/** The report as printable lines. */
export function formatReport(report: LiveReport): string[] {
  const lines: string[] = [];
  lines.push(
    ...table(
      ["recipe", "model", "schema", "claude", "agree", "refused", "truncated", "errors", "p50 ms", "p95 ms", "in tok", "out tok", "reason tok", "cost"],
      report.recipes.map((r) => [
        `${r.key} v${r.version}`,
        r.model,
        `${r.schemaPass}/${r.cases}`,
        r.baselineSchemaPassRate === null ? "-" : `${(r.baselineSchemaPassRate * 100).toFixed(0)}%`,
        r.agreement ? `${r.agreement.agreed}/${r.agreement.compared}` : "-",
        String(r.refusals),
        String(r.truncations),
        String(r.errors),
        String(r.latencyMs.p50),
        String(r.latencyMs.p95),
        String(r.tokens.inputTokens),
        String(r.tokens.outputTokens),
        String(r.tokens.reasoningTokens),
        usd(r.costMicros),
      ]),
    ),
  );
  for (const skip of report.skipped) {
    lines.push(`skipped ${skip.key}: ${skip.reason}`);
  }
  if (report.injection.length > 0) {
    lines.push("");
    lines.push(
      ...table(
        ["injection", "recipe", "status", "claude", "guard"],
        report.injection.map((i) => [
          i.id,
          i.recipeKey,
          i.status,
          i.baselinePass === null ? "-" : i.baselinePass ? "held" : "failed",
          i.guard,
        ]),
      ),
    );
  }
  if ((report.screening ?? []).length > 0) {
    lines.push("");
    lines.push(
      ...table(
        ["screening", "recipe", "expected", "named", "status"],
        report.screening.map((s) => [
          s.id,
          `${s.recipeKey} v${s.version}`,
          s.expected,
          s.named.length === 0 ? "-" : s.named.map((c) => c ?? "none").join(", "),
          s.pass ? "pass" : "fail",
        ]),
      ),
    );
  }
  lines.push("");
  lines.push(
    `Calls: ${report.totals.calls}. Tokens in ${report.totals.tokens.inputTokens} (cached ${report.totals.tokens.cachedInputTokens}), out ${report.totals.tokens.outputTokens} (reasoning ${report.totals.tokens.reasoningTokens}). Cost ${usd(report.totals.costMicros)}.`,
  );
  if (report.pass) {
    lines.push("Pass bar: met.");
  } else {
    lines.push("Pass bar: not met.");
    for (const failure of report.failures) lines.push(`  ${failure}`);
  }
  return lines;
}
