/**
 * Provider model seed: model IDs, list prices and failover order, verbatim
 * from CURVI_BUILD_PLAN.md sections 2.4 and 5.1 (prices dated September
 * 2026, verify at first live call). This module and recipes.ts are the ONLY
 * places model IDs and prices live (CLAUDE.md rule 2). The live runtime
 * builds provider registrations from these rows; nothing here executes.
 */

export interface LlmPriceTable {
  /** USD micros per million input tokens. */
  inputMicrosPerMTok: number;
  /** USD micros per million output tokens. */
  outputMicrosPerMTok: number;
}

/** Anthropic list prices per million tokens (plan section 5.1). */
export const llmModelPrices: Record<string, LlmPriceTable> = {
  "claude-haiku-4-5-20251001": { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 5_000_000 },
  "claude-sonnet-5": { inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000 },
  "claude-opus-5-5": { inputMicrosPerMTok: 4_000_000, outputMicrosPerMTok: 20_000_000 },
};

/** Task name the composite pipeline uses for background plate generation. */
export const SCENE_PLATE_TASK = "scene_plate";

/** Task name for the light and shadow harmonization edit pass. */
export const HARMONIZE_TASK = "harmonize";

/** Task name for product background removal. */
export const CUTOUT_TASK = "cutout";

export type ImageProviderFamily = "gemini" | "bfl" | "openai";

export interface ImageModelSeedRow {
  /** Registry provider name; also the routing table entry. */
  providerName: string;
  family: ImageProviderFamily;
  /** Model ID or path segment passed to the adapter. */
  model: string;
  /** Flat per generated image price in USD micros (plan section 2.4). */
  perImageMicros: number;
}

/**
 * Image generation chain in failover order (plan sections 1 and 2.4):
 * Nano Banana 2 default, FLUX.2 pro for plates, GPT Image 2 fallback.
 * Per image prices approximate a 1K to 2K plate: Nano Banana 2 $0.067 at
 * 1K, FLUX.2 pro $0.03 per MP taken at 2 MP, GPT Image 2 about $0.053 at
 * 1024 medium.
 */
export const imageModelSeedRows: ImageModelSeedRow[] = [
  { providerName: "gemini-image", family: "gemini", model: "gemini-3.1-flash-image", perImageMicros: 67_000 },
  { providerName: "bfl-flux", family: "bfl", model: "flux-2-pro", perImageMicros: 60_000 },
  { providerName: "openai-image", family: "openai", model: "gpt-image-2", perImageMicros: 53_000 },
];

/** Photoroom segment API, $0.02 per image (plan section 2.4). */
export const photoroomSeed = { providerName: "photoroom", perCallMicros: 20_000 };

/** Provider spend ceilings in USD micros (plan section 4.4). */
export const costCaps = {
  /** Hard stop per image asset including retries. */
  imageAssetMicros: 600_000,
  /** Hard stop per video asset including retries. */
  videoAssetMicros: 3_000_000,
  /** Hard stop for one full pack. */
  packMicros: 8_000_000,
} as const;
