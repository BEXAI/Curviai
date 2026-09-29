/**
 * The dark custom color line (PHASE_15 control 3). Pure and client safe (no
 * sharp): the new pack form shows "Dark colors can show a light edge around
 * your product." under a custom or brand color for which this is true. The
 * threshold is seed stillStyle.lightEdgeBelowLightness, set by the dark
 * swatch gate in fringe.test.ts.
 */
import { hexToRgb, rgbToLab } from "../color";
import { stillStyle } from "../seed/templates";

/** True when a cut out product on this background color can show a light edge. */
export function showsLightEdge(hex: string): boolean {
  const { r, g, b } = hexToRgb(hex);
  return rgbToLab(r, g, b).L < stillStyle.lightEdgeBelowLightness;
}
