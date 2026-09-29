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
  /** Per attempt timeout floor for a synchronous adapter, in ms. The router
   * default (60 s) is shorter than a slow generation, and a timed out sync
   * call is still paid for. OpenAI documents that complex prompts may take up
   * to 2 minutes (image generation guide, checked 2026-09-29). */
  minTimeoutMs?: number;
}

/**
 * Image generation chain in failover order (plan sections 1 and 2.4):
 * Nano Banana 2 default, FLUX.2 pro for plates, GPT Image 2 fallback.
 * Per image prices approximate a 1K to 2K plate: Nano Banana 2 $0.067 at
 * 1K, FLUX.2 pro $0.03 per MP taken at 2 MP, GPT Image 2 about $0.053 at
 * 1024 medium.
 */
export const imageModelSeedRows: ImageModelSeedRow[] = [
  { providerName: "gemini-image", family: "gemini", model: "gemini-3.1-flash-image", perImageMicros: 67_000, minTimeoutMs: 90_000 },
  { providerName: "bfl-flux", family: "bfl", model: "flux-2-pro", perImageMicros: 60_000 },
  { providerName: "openai-image", family: "openai", model: "gpt-image-2", perImageMicros: 53_000, minTimeoutMs: 150_000 },
];

export interface CutoutModelSeedRow {
  /** Registry provider name; also the routing table entry. */
  providerName: string;
  /** fal model ID passed to the queue gateway. */
  model: string;
  /** Extra request fields sent with every cutout. */
  params: Record<string, unknown>;
  /** Budgeted per image price in USD micros. */
  perCallMicros: number;
  /** Env var holding this row's fal key. A name, never a value. Each row
   * may bill a different fal account, so one empty balance fails over to the
   * next row instead of pausing every pack. A row whose key is unset is not
   * registered. */
  keyEnv: string;
}

/**
 * Cutout chain in failover order (Phase 14, 2026-09-29). Photoroom is a
 * competitor and no longer used. The default is BiRefNet (MIT licensed) on
 * fal.ai, at its highest resolution general use variant: "General Use
 * (Dynamic)" run at 2304x2304 (the only variant fal allows at that size),
 * for finer product borders than "General Use (Light 2K)" at 2048x2048. Never the Matting or
 * Portrait variants, and never BRIA RMBG 2.0, whose weights are non
 * commercial. fal lists BiRefNet v2 as billed per compute second (its page
 * showed "$0 per compute second" on 2026-09-29), so the price below is a
 * conservative budget of $0.01 per image: about 19 H100 seconds at fal's
 * $1.89 per hour, several times a 2K segmentation run. docs/verification.md.
 */
export const cutoutModelSeedRows: CutoutModelSeedRow[] = [
  {
    providerName: "fal-birefnet",
    model: "fal-ai/birefnet/v2",
    params: {
      model: "General Use (Dynamic)",
      operating_resolution: "2304x2304",
      output_format: "png",
      refine_foreground: true,
    },
    perCallMicros: 10_000,
    keyEnv: "FAL_KEY",
  },
  {
    // The same MIT BiRefNet model on a second fal account with its own
    // balance (audit 2026-09-29, PHASE_14 1.2). With a single row, one
    // exhausted fal balance ("Exhausted balance", HTTP 403) left the router
    // nothing to fail over to, and every pack that needs a cutout paused.
    // Registered only when FAL_KEY_BACKUP is set; same API, price and
    // parameters as the primary, so no new vendor or adapter is involved.
    providerName: "fal-birefnet-backup",
    model: "fal-ai/birefnet/v2",
    params: {
      model: "General Use (Dynamic)",
      operating_resolution: "2304x2304",
      output_format: "png",
      refine_foreground: true,
    },
    perCallMicros: 10_000,
    keyEnv: "FAL_KEY_BACKUP",
  },
];

/** Provider spend ceilings in USD micros (plan section 4.4). */
export const costCaps = {
  /** Hard stop per image asset including retries. */
  imageAssetMicros: 600_000,
  /** Hard stop per video asset including retries. */
  videoAssetMicros: 3_000_000,
  /** Hard stop for one full pack. */
  packMicros: 8_000_000,
} as const;
