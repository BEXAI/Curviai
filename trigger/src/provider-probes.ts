/**
 * The live providers wireLiveProviders (live-runtime.ts) would register for
 * a given env, described for health reporting: which key each one needs,
 * which pipeline stages it serves and, when its key is set, an adapter whose
 * probe() checks that key with a free metadata call (@curvi/ai probe.ts).
 *
 * It reads the same env names and the same seed rows as the live wiring
 * (llmModelPrices, imageModelSeedRows, cutoutModelSeedRows, recipeSeedRows), and
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
  FAL_API_KEY_ENV,
  FalCutoutProvider,
  type Provider,
} from "@curvi/ai";
import {
  CUTOUT_TASK,
  HARMONIZE_TASK,
  SCENE_PLATE_TASK,
  imageModelSeedRows,
  llmModelPrices,
  cutoutModelSeedRows,
  recipeSeedRows,
  type ImageModelSeedRow,
} from "@curvi/pipeline/seed";
import { llmModelProviderName } from "./recipes";

export type ReadEnv = (name: string) => string | undefined;
type FetchLike = typeof fetch;

export type LiveProviderKind = "llm" | "image" | "cutout";

export interface LiveProviderTarget {
  /** Registry name wireLiveProviders registers, e.g. "anthropic:<model>". */
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

function readEnvDefault(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/** LLM stages: every active seeded recipe stage. */
export function llmStages(): string[] {
  return [...new Set(recipeSeedRows.filter((row) => row.active).map((row) => row.stage))];
}

const IMAGE_KEY_ENV: Record<ImageModelSeedRow["family"], string> = {
  gemini: GEMINI_API_KEY_ENV,
  bfl: BFL_API_KEY_ENV,
  openai: OPENAI_API_KEY_ENV,
};

/** Every live provider the wiring knows, configured or not, in wiring order. */
export function liveProviderTargets(readEnv: ReadEnv = readEnvDefault, fetchFn?: FetchLike): LiveProviderTarget[] {
  const targets: LiveProviderTarget[] = [];

  const anthropicKey = readEnv(ANTHROPIC_API_KEY_ENV);
  const stages = llmStages();
  for (const [model, priceTable] of Object.entries(llmModelPrices)) {
    const name = llmModelProviderName(model);
    targets.push({
      name,
      kind: "llm",
      envVar: ANTHROPIC_API_KEY_ENV,
      stages,
      configured: Boolean(anthropicKey),
      provider: anthropicKey
        ? new AnthropicLLMProvider({ name, tasks: [], apiKey: anthropicKey, model, priceTable, fetchFn })
        : null,
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
  const falKey = readEnv(FAL_API_KEY_ENV);
  for (const row of cutoutModelSeedRows) {
    targets.push({
      name: row.providerName,
      kind: "cutout",
      envVar: FAL_API_KEY_ENV,
      stages: [CUTOUT_TASK],
      configured: Boolean(falKey),
      provider: falKey
        ? new FalCutoutProvider({
            name: row.providerName,
            tasks: [],
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
