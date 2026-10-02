/**
 * The live providers wireLiveProviders (live-runtime.ts) would register for
 * a given env, described for health reporting: which key each one needs,
 * which pipeline stages it serves and, when its key is set, an adapter whose
 * probe() checks that key with a free metadata call (@curvi/ai probe.ts).
 *
 * It reads the same env names and the same seed rows as the live wiring
 * (llmModelPrices, llmModelProviders, imageModelSeedRows, cutoutModelSeedRows,
 * recipeSeedRows), and
 * a test holds the two lists equal, so the health endpoint and the probe
 * route always describe what a pack would actually run on. Nothing here
 * makes a network call; constructing an adapter is free.
 */

import {
  ANTHROPIC_API_KEY_ENV,
  AnthropicLLMProvider,
  BFL_API_KEY_ENV,
  BflFluxProvider,
  GEMINI_API_KEY_ENV,
  GeminiImageProvider,
  OPENAI_API_KEY_ENV,
  OpenaiImageProvider,
  OpenaiLLMProvider,
  FalCutoutProvider,
  type Provider,
} from "@curvi/ai";
import {
  CUTOUT_TASK,
  HARMONIZE_TASK,
  SCENE_PLATE_TASK,
  imageModelSeedRows,
  llmImageTokenMultipliers,
  llmModelPrices,
  llmModelProviders,
  cutoutModelSeedRows,
  recipeSeedRows,
  type ImageModelSeedRow,
  type LlmProviderFamily,
} from "@curvi/pipeline/seed";
import { optionalEnv, type ReadEnv } from "./env";
import { llmModelProviderName, openaiLlmPriceTable } from "./recipes";

export type { ReadEnv } from "./env";
type FetchLike = typeof fetch;

export type LiveProviderKind = "llm" | "image" | "cutout";

export interface LiveProviderTarget {
  /** Registry name wireLiveProviders registers, e.g. "openai:<model>". */
  name: string;
  kind: LiveProviderKind;
  /** Env var holding the key. A name, never a value. */
  envVar: string;
  /** Pipeline stages this provider serves. */
  stages: string[];
  configured: boolean;
  /** An adapter to probe the key with; null when the key is unset. */
  provider: Provider | null;
}

/** LLM stages: every active seeded recipe stage. */
export function llmStages(): string[] {
  return [...new Set(recipeSeedRows.filter((row) => row.active).map((row) => row.stage))];
}

/** The stages whose active recipe versions list model in their chain or
 * escalation, so a stage report says which keys can run that stage. */
export function llmStagesFor(model: string): string[] {
  return llmStages().filter((stage) =>
    recipeSeedRows.some(
      (row) =>
        row.active &&
        row.stage === stage &&
        (row.model === model || (row.fallbackModels ?? []).includes(model) || (row.body.escalation ?? []).includes(model)),
    ),
  );
}

/** Env var holding each LLM provider family's key. */
export const LLM_KEY_ENV: Record<LlmProviderFamily, string> = {
  anthropic: ANTHROPIC_API_KEY_ENV,
  openai: OPENAI_API_KEY_ENV,
};

const IMAGE_KEY_ENV: Record<ImageModelSeedRow["family"], string> = {
  gemini: GEMINI_API_KEY_ENV,
  bfl: BFL_API_KEY_ENV,
  openai: OPENAI_API_KEY_ENV,
};

/** Every live provider the wiring knows, configured or not, in wiring order. */
export function liveProviderTargets(readEnv: ReadEnv = optionalEnv, fetchFn?: FetchLike): LiveProviderTarget[] {
  const targets: LiveProviderTarget[] = [];

  // One target per priced LLM model, keyed by its provider family
  // (llmModelProviders), so the probe covers every model a chain can reach.
  // A model with no provider or no OpenAI image multiplier is never wired,
  // so it is not listed either.
  for (const [model, priceTable] of Object.entries(llmModelPrices)) {
    const family = Object.hasOwn(llmModelProviders, model) ? llmModelProviders[model] : undefined;
    if (!family) continue;
    const imageTokenMultiplier = llmImageTokenMultipliers[model];
    const openaiPrices = openaiLlmPriceTable(priceTable);
    // An OpenAI model without a seeded multiplier or cached input price is
    // never wired (live-runtime fails closed), so it is not probed either.
    const openaiConfig =
      family === "openai" && imageTokenMultiplier !== undefined && openaiPrices
        ? { priceTable: openaiPrices, imageTokenMultiplier }
        : undefined;
    if (family === "openai" && !openaiConfig) continue;
    const name = llmModelProviderName(model);
    const envVar = LLM_KEY_ENV[family];
    const apiKey = readEnv(envVar);
    let provider: Provider | null = null;
    if (apiKey) {
      provider = openaiConfig
        ? new OpenaiLLMProvider({ name, tasks: [], apiKey, model, ...openaiConfig, fetchFn })
        : new AnthropicLLMProvider({ name, tasks: [], apiKey, model, priceTable, fetchFn });
    }
    targets.push({
      name,
      kind: "llm",
      envVar,
      stages: llmStagesFor(model),
      configured: Boolean(apiKey),
      provider,
    });
  }

  for (const row of imageModelSeedRows) {
    const envVar = IMAGE_KEY_ENV[row.family];
    const apiKey = readEnv(envVar);
    const config = {
      name: row.providerName,
      tasks: [],
      apiKey: apiKey ?? "",
      model: row.model,
      priceTable: { perImageMicros: row.perImageMicros },
      fetchFn,
    };
    targets.push({
      name: row.providerName,
      kind: "image",
      envVar,
      stages: [SCENE_PLATE_TASK, HARMONIZE_TASK],
      configured: Boolean(apiKey),
      provider: !apiKey
        ? null
        : row.family === "gemini"
          ? new GeminiImageProvider(config)
          : row.family === "bfl"
            ? new BflFluxProvider(config)
            : new OpenaiImageProvider(config),
    });
  }

  // Cutouts run on fal (BiRefNet). fal has no free key probe, so the
  // provider is listed as skipped by the probe route; breaker state and
  // quota warnings cover it (docs/phases/PHASE_14.md 1.2, 1.5).
  for (const row of cutoutModelSeedRows) {
    const falKey = readEnv(row.keyEnv);
    targets.push({
      name: row.providerName,
      kind: "cutout",
      envVar: row.keyEnv,
      stages: [CUTOUT_TASK],
      configured: Boolean(falKey),
      provider: falKey
        ? new FalCutoutProvider({
            name: row.providerName,
            tasks: [CUTOUT_TASK],
            apiKey: falKey,
            modelId: row.model,
            modelParams: row.params,
            priceTable: { perCallMicros: row.perCallMicros },
            fetchFn,
          })
        : null,
    });
  }

  return targets;
}

export interface StageKeyReport {
  stage: string;
  kind: LiveProviderKind;
  /** True when at least one provider for the stage has its key set. */
  ready: boolean;
  /** Key presence per env var name. Presence only, never values. */
  keys: Array<{ envVar: string; present: boolean }>;
}

/** Which keys each pipeline stage can use, and whether it has one. */
export function stageKeyReport(targets: LiveProviderTarget[]): StageKeyReport[] {
  const byStage = new Map<string, StageKeyReport>();
  for (const target of targets) {
    for (const stage of target.stages) {
      const entry = byStage.get(stage) ?? { stage, kind: target.kind, ready: false, keys: [] };
      if (!entry.keys.some((key) => key.envVar === target.envVar)) {
        entry.keys.push({ envVar: target.envVar, present: target.configured });
      }
      entry.ready = entry.ready || target.configured;
      byStage.set(stage, entry);
    }
  }
  return [...byStage.values()];
}
