/**
 * The seller's confirmation of a logo palette suggestion (PHASE_16
 * workstream 7). Kept free of server imports because the brand kit form
 * runs it in the browser.
 */

import type { BrandKitSuggestion } from "@curvi/pipeline/brand";

/**
 * The colors the kit takes when the seller confirms: the picked brand
 * colors in order, then the suggested background when kept, without
 * repeats and at most maxColors. Pure, so the form and its tests agree.
 */
export function confirmedColors(
  suggestion: Pick<BrandKitSuggestion, "colors" | "background">,
  picked: readonly string[],
  keepBackground: boolean,
  maxColors: number,
): string[] {
  const allowed = new Set(suggestion.colors.map((c) => c.hex.toUpperCase()));
  const out: string[] = [];
  for (const hex of picked) {
    const upper = hex.toUpperCase();
    if (allowed.has(upper) && !out.includes(upper)) {
      out.push(upper);
    }
  }
  const background = suggestion.background.hex.toUpperCase();
  if (keepBackground && !out.includes(background)) {
    out.push(background);
  }
  return out.slice(0, maxColors);
}
