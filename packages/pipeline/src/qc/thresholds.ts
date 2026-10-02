/**
 * Threshold table from section 5.6. Values here are the QC contract; do not
 * inline copies elsewhere. The module has no imports, so copy can cite the
 * limits (the fidelity color difference rows in help, P18-09) through
 * @curvi/pipeline/qc-thresholds without loading the pixel checks;
 * pixelChecks.ts re-exports it.
 */
export const QC_THRESHOLDS = {
  main: {
    /** Share of outside mask pixels equal to 255,255,255 after forcing. */
    backgroundWhiteShareAfterForcing: 1.0,
    /** Before the forcing step. */
    backgroundWhiteShareBeforeForcing: 0.999,
    fillMin: 0.85,
    fillMax: 0.9,
    /** 2000 px or more preferred. */
    preferredLongSide: 2000,
    minLongSide: 1600,
    /** OCR on the non product area must find zero text. */
    maxNonProductOcrChars: 0,
    /** Label OCR match vs source, normalized Levenshtein. */
    minLabelOcrMatch: 0.95,
    /** DINOv2 or CLIP embedding cosine on the product crop. */
    minEmbeddingCosine: 0.92,
    /** Mean CIEDE2000 on the product mask. */
    maxMeanDeltaE: 3.0,
    minLlmFidelity: 0.9,
  },
  other: {
    minLabelOcrMatch: 0.92,
    minEmbeddingCosine: 0.88,
    maxMeanDeltaE: 5.0,
    minLlmFidelity: 0.85,
  },
  /**
   * white_or_transparent and white_preferred specs (Google main, TikTok
   * Shop): share of outside mask pixels that are exactly 255 white or fully
   * transparent (PHASE_15 backgroundWhiteOrClear).
   */
  whiteOrClearShare: 0.999,
  /**
   * "Background matches your color" (PHASE_15 P1): the most CIEDE2000
   * between the requested background and the median color measured outside
   * the (margin dilated) mask, on outputs with a chosen color or added space.
   */
  backdropMaxDeltaE: 2.0,
} as const;
