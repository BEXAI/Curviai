/**
 * Brand kit value for the style preset meaning "let the planner pick from
 * the product category". Any seeded preset key replaces the planner's pick.
 */
export const AUTO_STYLE_PRESET = "auto";

/** The most colors one brand kit may hold. The brand kit form, its API and
 * the brand background color choice (PHASE_15 control 3) all read it. */
export const MAX_BRAND_COLORS = 6;

/**
 * Brand kit from a logo (docs/phases/PHASE_16.md workstream 7). Every
 * threshold the palette reader uses, so tuning is a seed change (CLAUDE.md
 * rule 2). Lightness and chroma are CIELAB (D65); color distances are
 * CIEDE2000 unless a field says otherwise.
 */
export const brandPalette = {
  /** The logo is read at most this many pixels on its long side. */
  sampleLongSide: 256,
  /** Pixels with alpha below this are transparent and ignored. */
  opaqueAlphaMin: 128,
  /** Near white pixels (the paper a logo sits on, a JPEG's white box) are
   * ignored: L* at or above minLightness with chroma at or below maxChroma. */
  nearWhite: { minLightness: 93, maxChroma: 6 },
  /** k for the k means pass in Lab, before merging. */
  clusters: 8,
  maxIterations: 24,
  /** Two clusters closer than this are one color. */
  mergeDeltaE: 8,
  /** A cluster under this share of the kept pixels is edge blending or
   * noise, not a brand color. */
  minShare: 0.03,
  /** A color's swatch is the mean of the pixels within this Lab (Euclidean)
   * distance of its densest bin, so soft edges do not pull it off the ink. */
  swatchRadius: 5,
  /** The kit takes at most this many colors from a logo (PHASE_16: 3 to 5),
   * which leaves room for the suggested background under MAX_BRAND_COLORS. */
  maxColors: 5,
  /**
   * The reading is ambiguous, and the vision recipe (stage "brand") names
   * and picks the colors, when more significant clusters than maxColors
   * remain, or when less than minCoverage of the kept pixels lies within
   * coverageDeltaE of a picked color (gradients, photos, shading).
   * Measured 2026-09-29 on the fixtures in packages/pipeline/src/brand:
   * flat logos, PNG or JPEG, cover 0.92 or more; a two stop ramp 0.65 and
   * a three stop gradient 0.71.
   */
  ambiguity: { minCoverage: 0.85, coverageDeltaE: 4 },
  /** The suggested background: the leading brand color as a pale tint at
   * this L*, keeping chromaScale of its chroma. It stays above
   * stillStyle.lightEdgeBelowLightness, so no light edge shows around a
   * cut out product. */
  backgroundTint: { lightness: 95, chromaScale: 0.12 },
  /** WCAG 2.2 SC 1.4.3 minimum contrast for normal text (docs/verification.md). */
  minContrastRatio: 4.5,
  /** Long side of the logo image the vision recipe sees. */
  visionLongSide: 768,
  /** Longest color name kept from the vision answer. */
  nameMaxLength: 32,
} as const;
