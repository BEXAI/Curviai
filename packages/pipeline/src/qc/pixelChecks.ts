/**
 * Deterministic pixel checks parameterized by a ChannelSpec
 * (CURVI_BUILD_PLAN.md section 5.6). These run before any LLM judge and their
 * numbers are handed to the judge, which must trust them over its impression.
 */
import { dimensionBounds, type ChannelSpec } from "@curvi/specs";
import { boundingBoxOfMask, dilate } from "../mask";
import type { RawImage, RawMask } from "../raw";

/**
 * Threshold table from section 5.6. Values here are the QC contract; do not
 * inline copies elsewhere.
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
} as const;

/**
 * Whether pixelChecks runs backgroundWhiteOrClear by default. Off: today's
 * white renders for google.merchant.main and tiktokshop.main pass it as
 * rendered and as PNG, but ship as a quality 90 JPEG whose ringing leaves
 * about 0.99 of the background exactly white outside the edge margin
 * (qc/whiteOrClear.test.ts). Turn it on once encodeForSpec escapes these
 * specs to PNG the way it does for solid white specs, and a golden set run
 * passes. A caller can opt in per call with
 * PixelCheckOptions.backgroundWhiteOrClear.
 */
export const BACKGROUND_WHITE_OR_CLEAR_ENABLED = false;

/** True for the background rules backgroundWhiteOrClear covers. */
export function needsWhiteOrClear(spec: ChannelSpec): boolean {
  const type = spec.background?.type;
  return type === "white_or_transparent" || type === "white_preferred";
}

export type QcKind = "main" | "other";

export interface CheckItem {
  name: string;
  pass: boolean;
  measured: number | string | null;
  limit: string;
}

export interface PixelCheckReport {
  specId: string;
  kind: QcKind;
  width: number;
  height: number;
  longestSide: number;
  backgroundWhiteShare: number | null;
  fillRatio: number | null;
  bytes: number | null;
  format: string | null;
  checks: CheckItem[];
  pass: boolean;
}

export interface PixelCheckOptions {
  /** Encoded file facts, when the caller has the final bytes. */
  encoded?: { bytes: number; format: string };
  /**
   * Pixels within this many px of the product edge belong to the mask edge
   * transition (resampling plus codec blocks), not to the background. The
   * background white share is measured outside the mask dilated by this
   * margin, so a globally suppressed background (the 254 white risk) is still
   * caught while honest anti aliased edges are not punished.
   */
  edgeMarginPx?: number;
  /** Run backgroundWhiteOrClear on white or transparent and white preferred
   * specs. Default BACKGROUND_WHITE_OR_CLEAR_ENABLED. */
  backgroundWhiteOrClear?: boolean;
}

/** Main class checks apply when the spec demands a pure white solid background with no text. */
export function qcKindForSpec(spec: ChannelSpec): QcKind {
  const bg = spec.background;
  const isPureWhite =
    bg?.type === "solid" && !!bg.rgb && bg.rgb[0] === 255 && bg.rgb[1] === 255 && bg.rgb[2] === 255;
  return isPureWhite && spec.textAllowed !== true ? "main" : "other";
}

/**
 * The shortest acceptable long side for this spec. The spec's own
 * minLongSide wins when set (the registry's amazon.main says 1600); the
 * section 5.6 constant is the fallback for main class specs that omit it.
 * Renderers that shrink an output to fit a byte limit stop here.
 */
export function minLongSideFor(spec: ChannelSpec): number {
  const bounds = dimensionBounds(spec);
  const fromSpec = spec.minLongSide ?? (qcKindForSpec(spec) === "main" ? QC_THRESHOLDS.main.minLongSide : 1);
  return Math.max(fromSpec, bounds.minLongSide);
}

/** Reported as the measured value of a check that needs a mask it did not get. */
export const MASK_MISSING = "mask missing";

export async function pixelChecks(
  image: RawImage,
  mask: RawMask | null,
  spec: ChannelSpec,
  opts: PixelCheckOptions = {},
): Promise<PixelCheckReport> {
  const kind = qcKindForSpec(spec);
  const checks: CheckItem[] = [];
  const longestSide = Math.max(image.width, image.height);

  // Dimension checks via the spec registry bounds. An exactSize spec
  // (social feeds, pins, banners) accepts only its own width and height.
  const bounds = dimensionBounds(spec);
  const exact = bounds.minWidth === bounds.maxWidth && bounds.minHeight === bounds.maxHeight;
  checks.push({
    name: "dimensions",
    pass:
      image.width >= bounds.minWidth &&
      image.height >= bounds.minHeight &&
      image.width <= bounds.maxWidth &&
      image.height <= bounds.maxHeight,
    measured: `${image.width}x${image.height}`,
    limit: exact
      ? `exactly ${bounds.maxWidth}x${bounds.maxHeight}`
      : `${bounds.minWidth}x${bounds.minHeight} to ${bounds.maxWidth}x${bounds.maxHeight}`,
  });
  // Main white images need at least 1600 px on the longest side.
  const minLong = minLongSideFor(spec);
  checks.push({
    name: "longestSide",
    pass: longestSide >= minLong && longestSide <= bounds.maxLongSide,
    measured: longestSide,
    limit: `${minLong} to ${bounds.maxLongSide}`,
  });

  // Fail closed: a rule that needs the product mask cannot pass without one.
  // Main class specs always need both the background and the fill rule, so a
  // generation that returns no mask can never ship as a main image.
  const needsBackground = kind === "main" || (spec.background?.type === "solid" && !!spec.background.rgb);
  const fillMin = spec.fill?.min ?? (kind === "main" ? QC_THRESHOLDS.main.fillMin : null);
  const fillMax = spec.fill?.max ?? (kind === "main" ? QC_THRESHOLDS.main.fillMax : null);
  const needsFill = fillMin !== null && fillMax !== null;
  const backgroundRequired =
    kind === "main" ? QC_THRESHOLDS.main.backgroundWhiteShareAfterForcing : 0.999;

  // Background white share outside the (margin dilated) mask.
  let backgroundWhiteShare: number | null = null;
  if (needsBackground && !mask) {
    checks.push({
      name: "backgroundWhiteShare",
      pass: false,
      measured: MASK_MISSING,
      limit: `>= ${backgroundRequired}`,
    });
  } else if (mask && spec.background?.type === "solid" && spec.background.rgb) {
    const [br, bg2, bb] = spec.background.rgb;
    const margin = opts.edgeMarginPx ?? 0;
    const checkMask = margin > 0 ? await dilate(mask, margin) : mask;
    let outside = 0;
    let matching = 0;
    for (let i = 0; i < checkMask.data.length; i++) {
      if (checkMask.data[i] !== 0) {
        continue;
      }
      outside++;
      const o = i * 4;
      if (image.data[o] === br && image.data[o + 1] === bg2 && image.data[o + 2] === bb) {
        matching++;
      }
    }
    backgroundWhiteShare = outside === 0 ? 1 : matching / outside;
    checks.push({
      name: "backgroundWhiteShare",
      pass: backgroundWhiteShare >= backgroundRequired,
      measured: backgroundWhiteShare,
      limit: `>= ${backgroundRequired}`,
    });
  }

  // White or transparent background outside the (margin dilated) mask, for
  // the specs whose rule is not a solid color. Fails closed without a mask.
  if ((opts.backgroundWhiteOrClear ?? BACKGROUND_WHITE_OR_CLEAR_ENABLED) && needsWhiteOrClear(spec)) {
    const required = QC_THRESHOLDS.whiteOrClearShare;
    if (!mask) {
      checks.push({ name: "backgroundWhiteOrClear", pass: false, measured: MASK_MISSING, limit: `>= ${required}` });
    } else {
      const margin = opts.edgeMarginPx ?? 0;
      const checkMask = margin > 0 ? await dilate(mask, margin) : mask;
      const share = whiteOrClearShare(image, checkMask);
      checks.push({ name: "backgroundWhiteOrClear", pass: share >= required, measured: share, limit: `>= ${required}` });
    }
  }

  // Megapixels, when the spec caps them.
  if (spec.maxMegapixels !== undefined) {
    checks.push(megapixelsCheck(image.width, image.height, spec.maxMegapixels));
  }

  // Fill ratio: product bounding box longest side over canvas longest side.
  let fillRatio: number | null = null;
  if (mask) {
    const bbox = boundingBoxOfMask(mask);
    if (bbox) {
      fillRatio = Math.max(bbox.width, bbox.height) / longestSide;
    } else {
      fillRatio = 0;
    }
    if (needsFill) {
      checks.push({
        name: "fillRatio",
        pass: fillRatio >= fillMin && fillRatio <= fillMax,
        measured: fillRatio,
        limit: `${fillMin} to ${fillMax}`,
      });
    }
  } else if (needsFill) {
    checks.push({
      name: "fillRatio",
      pass: false,
      measured: MASK_MISSING,
      limit: `${fillMin} to ${fillMax}`,
    });
  }

  // Encoded file checks.
  let bytes: number | null = null;
  let format: string | null = null;
  if (opts.encoded) {
    bytes = opts.encoded.bytes;
    format = opts.encoded.format;
    if (spec.maxBytes) {
      checks.push({
        name: "bytes",
        pass: bytes <= spec.maxBytes,
        measured: bytes,
        limit: `<= ${spec.maxBytes}`,
      });
    }
    if (spec.formats) {
      checks.push({
        name: "format",
        pass: (spec.formats as readonly string[]).includes(normalizeFormat(format)),
        measured: format,
        limit: spec.formats.join(", "),
      });
    }
  }

  return {
    specId: spec.id,
    kind,
    width: image.width,
    height: image.height,
    longestSide,
    backgroundWhiteShare,
    fillRatio,
    bytes,
    format,
    checks,
    pass: checks.every((c) => c.pass),
  };
}

/** Share of pixels outside the mask that are exactly 255 white or alpha 0; 1 when none are outside. */
function whiteOrClearShare(image: RawImage, checkMask: RawMask): number {
  let outside = 0;
  let matching = 0;
  for (let i = 0; i < checkMask.data.length; i++) {
    if (checkMask.data[i] !== 0) {
      continue;
    }
    outside++;
    const o = i * 4;
    if (
      image.data[o + 3] === 0 ||
      (image.data[o] === 255 && image.data[o + 1] === 255 && image.data[o + 2] === 255)
    ) {
      matching++;
    }
  }
  return outside === 0 ? 1 : matching / outside;
}

function megapixelsCheck(width: number, height: number, maxMegapixels: number): CheckItem {
  const megapixels = (width * height) / 1_000_000;
  return { name: "megapixels", pass: megapixels <= maxMegapixels, measured: megapixels, limit: `<= ${maxMegapixels}` };
}

/**
 * The checks a file gets from its header alone: dimensions, long side,
 * megapixels, bytes and format. Used for a kept photo shipped unchanged,
 * whose bytes are proven by sha256 instead of decoded (PHASE_15 fidelity
 * section).
 */
export function headerChecks(
  width: number,
  height: number,
  spec: ChannelSpec,
  encoded: { bytes: number; format: string },
): CheckItem[] {
  const bounds = dimensionBounds(spec);
  const longestSide = Math.max(width, height);
  const minLong = minLongSideFor(spec);
  const checks: CheckItem[] = [
    {
      name: "dimensions",
      pass:
        width >= bounds.minWidth && height >= bounds.minHeight && width <= bounds.maxWidth && height <= bounds.maxHeight,
      measured: `${width}x${height}`,
      limit: `${bounds.minWidth}x${bounds.minHeight} to ${bounds.maxWidth}x${bounds.maxHeight}`,
    },
    {
      name: "longestSide",
      pass: longestSide >= minLong && longestSide <= bounds.maxLongSide,
      measured: longestSide,
      limit: `${minLong} to ${bounds.maxLongSide}`,
    },
  ];
  if (spec.maxMegapixels !== undefined) {
    checks.push(megapixelsCheck(width, height, spec.maxMegapixels));
  }
  if (spec.maxBytes) {
    checks.push({ name: "bytes", pass: encoded.bytes <= spec.maxBytes, measured: encoded.bytes, limit: `<= ${spec.maxBytes}` });
  }
  if (spec.formats) {
    checks.push({
      name: "format",
      pass: (spec.formats as readonly string[]).includes(normalizeFormat(encoded.format)),
      measured: encoded.format,
      limit: spec.formats.join(", "),
    });
  }
  return checks;
}

function normalizeFormat(format: string): string {
  const f = format.toLowerCase();
  if (f === "jpeg") return "jpg";
  if (f === "tiff") return "tif";
  return f;
}

/**
 * Pluggable OCR check on the non product area. Real engine is a follow up;
 * a mock lives in src/qc/testing for tests and the eval harness, and is
 * never a default in production code paths.
 */
export interface OcrTextCheck {
  name: string;
  /** Text characters detected outside the product mask. */
  nonProductText(image: RawImage, mask: RawMask): Promise<string>;
  /** Normalized Levenshtein similarity of label text vs the source, 0..1. */
  labelMatch(original: RawImage, composed: RawImage, mask: RawMask): Promise<number>;
}

/**
 * Pluggable product crop embedding similarity (DINOv2 or CLIP cosine).
 * Real model is a follow up; the mock in src/qc/testing keeps the interface
 * honest without ever being a production default.
 */
export interface EmbeddingCosineCheck {
  name: string;
  cosine(original: RawImage, composed: RawImage, mask: RawMask): Promise<number>;
}

export interface SemanticCheckResult {
  checks: CheckItem[];
  pass: boolean;
}

/**
 * Run the pluggable OCR and embedding checks against the section 5.6
 * thresholds. Both engines are REQUIRED: there are no mock defaults, so a
 * caller cannot silently pass the label and embedding gates by omitting the
 * arguments. Tests and the eval harness may opt in to the mocks explicitly
 * via src/qc/testing.
 */
export async function semanticChecks(
  original: RawImage,
  composed: RawImage,
  mask: RawMask,
  kind: QcKind,
  ocr: OcrTextCheck,
  embedding: EmbeddingCosineCheck,
): Promise<SemanticCheckResult> {
  const checks: CheckItem[] = [];
  if (kind === "main") {
    const strayText = await ocr.nonProductText(composed, mask);
    checks.push({
      name: `ocrNonProductText (${ocr.name})`,
      pass: strayText.length <= QC_THRESHOLDS.main.maxNonProductOcrChars,
      measured: strayText.length,
      limit: `<= ${QC_THRESHOLDS.main.maxNonProductOcrChars} characters`,
    });
  }
  const labelMatch = await ocr.labelMatch(original, composed, mask);
  const minLabel = QC_THRESHOLDS[kind].minLabelOcrMatch;
  checks.push({
    name: `labelOcrMatch (${ocr.name})`,
    pass: labelMatch >= minLabel,
    measured: labelMatch,
    limit: `>= ${minLabel}`,
  });
  const cosine = await embedding.cosine(original, composed, mask);
  const minCosine = QC_THRESHOLDS[kind].minEmbeddingCosine;
  checks.push({
    name: `embeddingCosine (${embedding.name})`,
    pass: cosine >= minCosine,
    measured: cosine,
    limit: `>= ${minCosine}`,
  });
  return { checks, pass: checks.every((c) => c.pass) };
}
