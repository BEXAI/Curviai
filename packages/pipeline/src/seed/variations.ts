/**
 * Scene variations per lifestyle scene (PHASE_16 workstream 6, founder
 * decision 3): the seller asks for min to max versions of each scene and
 * picks which ones ship. The first is the scene itself, at its normal price;
 * each extra one is charged at creditCosts.generativeStill. Its own module
 * with no imports, so the Shot schema reads the limits without an import
 * cycle.
 */
export const variationOptions = {
  min: 1,
  max: 4,
  default: 1,
} as const;
