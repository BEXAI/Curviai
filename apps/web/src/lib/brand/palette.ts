/**
 * Brand kit from a logo, web side (docs/phases/PHASE_16.md workstream 7).
 * The brand page asks for a palette suggestion after a logo upload; the
 * worker runtime reads it (trigger/src/brand-palette.ts: pixels first, the
 * seeded vision recipe through @curvi/ai only when the reading is
 * ambiguous). The answer is a suggestion only: nothing here writes the
 * brand kit, which saves only when the seller confirms and presses save.
 */

import type { BrandPaletteArgs, BrandPaletteRun } from "@curvi/trigger/brand-palette";
import { brandKitCopy } from "@/components/marketing/brand-kit-copy";
import type { BrandPaletteOutcome } from "./types";

export type { BrandPaletteOutcome, BrandPaletteRefusal } from "./types";

export type BrandPaletteRunner = (args: BrandPaletteArgs) => Promise<BrandPaletteRun>;

/** The worker runtime's palette reader, loaded on first use like the
 * preflight at upload loads its runner. */
export async function defaultBrandPaletteRun(args: BrandPaletteArgs): Promise<BrandPaletteRun> {
  const [{ resolveRuntimeDeps }, { runBrandPalette }] = await Promise.all([
    import("@curvi/trigger/db-runtime"),
    import("@curvi/trigger/brand-palette"),
  ]);
  return runBrandPalette(resolveRuntimeDeps(), args);
}

/** The page's answer for one run. */
export function brandPaletteOutcomeOf(run: BrandPaletteRun): BrandPaletteOutcome {
  if (run.missing) {
    return { ok: false, reason: "foreign_key", notice: brandKitCopy.paletteMissing };
  }
  if (run.unreadable || !run.suggestion) {
    return { ok: false, reason: "invalid_upload", notice: brandKitCopy.paletteUnreadable };
  }
  if (run.suggestion.colors.length === 0) {
    return { ok: false, reason: "no_colors", notice: brandKitCopy.paletteNoColors };
  }
  return { ok: true, suggestion: run.suggestion };
}
