/**
 * Brand kit from a logo, runner side (docs/phases/PHASE_16.md workstream 7).
 * The web app calls this when a seller uploads a logo at /app/brand:
 *
 * 1. the logo is loaded from the workspace's own prefix and read
 *    deterministically (readLogoPalette in @curvi/pipeline): no model call
 *    for a simple logo;
 * 2. only when that reading is ambiguous, the seeded brand_palette_namer
 *    recipe (stage "brand") sees the logo on gray and the measured
 *    candidates, through the same llmJson path the packs use, so the call is
 *    metered, capped and fails over in @curvi/ai (CLAUDE.md rule 4);
 * 3. the answer is merged by applyPaletteNaming, which only keeps measured
 *    candidates. A failed or refused call keeps the pixel suggestion.
 *
 * Nothing is saved here: the result is a suggestion the seller confirms on
 * the page. Spend comes back as costMicros for the caller to log.
 */

import {
  applyPaletteNaming,
  logoVisionJpeg,
  PaletteNaming,
  paletteNamingPayload,
  paletteNeedsVision,
  readLogoPalette,
  suggestionFromReading,
  type BrandKitSuggestion,
} from "@curvi/pipeline";
import { isWorkspaceObjectKey } from "./object-keys";
import { failureSpendMicros, llmJson, type PipelineDeps } from "./pipeline-runner";
import { recipeFor, seedJobRecipes, type JobRecipes } from "./recipes";

export interface BrandPaletteArgs {
  /** A fresh id for this reading: the job id the metered call carries. */
  requestId: string;
  workspaceId: string;
  /** The uploaded logo's object key (ws/{workspaceId}/src/...). */
  logoKey: string;
}

export interface BrandPaletteRun {
  /** The logo was not in this workspace or could not be loaded. */
  missing: boolean;
  /** The logo could not be decoded as an image. */
  unreadable: boolean;
  suggestion: BrandKitSuggestion | null;
  /** True when the vision recipe was asked (whether or not it answered). */
  askedVision: boolean;
  /** Provider spend, in USD micros. */
  costMicros: number;
}

async function recipesFor(deps: PipelineDeps, requestId: string): Promise<JobRecipes> {
  try {
    return deps.recipes ? await deps.recipes.forJob(requestId) : seedJobRecipes();
  } catch (err) {
    console.error(`[brand-palette] could not assign recipes for ${requestId}; using the seed recipes`, err);
    return seedJobRecipes();
  }
}

export async function runBrandPalette(deps: PipelineDeps, args: BrandPaletteArgs): Promise<BrandPaletteRun> {
  const run: BrandPaletteRun = { missing: false, unreadable: false, suggestion: null, askedVision: false, costMicros: 0 };
  const { requestId, workspaceId, logoKey } = args;
  if (!isWorkspaceObjectKey(workspaceId, logoKey) || !deps.loadMedia) {
    return { ...run, missing: true };
  }
  const bytes = await deps.loadMedia(logoKey).catch(() => null);
  if (!bytes || bytes.length === 0) {
    return { ...run, missing: true };
  }
  const reading = await readLogoPalette(bytes).catch(() => null);
  if (!reading) {
    return { ...run, unreadable: true };
  }
  run.suggestion = suggestionFromReading(reading);
  if (!paletteNeedsVision(reading)) {
    return run;
  }

  const image = await logoVisionJpeg(bytes).catch(() => null);
  if (!image) {
    return run;
  }
  run.askedVision = true;
  const recipes = await recipesFor(deps, requestId);
  try {
    const answer = await llmJson<PaletteNaming>(
      deps.ai,
      recipeFor(recipes, "brand"),
      PaletteNaming,
      paletteNamingPayload(reading),
      { jobId: requestId, workspaceId, stepId: "brand:palette" },
      [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image.toString("base64") } }],
      PaletteNaming,
    );
    run.costMicros += answer.costMicros;
    if (answer.value) {
      run.suggestion = applyPaletteNaming(reading, answer.value);
    }
  } catch (err) {
    run.costMicros += failureSpendMicros(err);
    console.warn(`[brand-palette] the palette namer failed for ${requestId}; keeping the pixel reading`, err);
  }
  return run;
}
