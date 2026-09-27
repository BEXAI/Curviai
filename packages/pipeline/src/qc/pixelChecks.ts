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
} as const;

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
}

/** Main class checks apply when the spec demands a pure white solid background with no text. */
export function qcKindForSpec(spec: ChannelSpec): QcKind {
  const bg = spec.background;
  const isPureWhite =
    bg?.type === "solid" && !!bg.rgb && bg.rgb[0] === 255 && bg.rgb[1] === 255 && bg.rgb[2] === 255;
  return isPureWhite && spec.textAllowed !== true ? "main" : "other";
}

export async function pixelChecks(
  image: RawImage,
  mask: RawMask | null,
  spec: ChannelSpec,
  opts: PixelCheckOptions = {},
): Promise<PixelCheckReport> {
  const kind = qcKindForSpec(spec);
  const checks: CheckItem[] = [];
  const longestSide = Math.max(image.width, image.height);

  // Dimension checks via the spec registry bounds.
  const bounds = dimensionBounds(spec);
  checks.push({
    name: "dimensions",
    pass:
      image.width >= bounds.minWidth &&
      image.height >= bounds.minHeight &&
      image.width <= bounds.maxWidth &&
      image.height <= bounds.maxHeight,
    measured: `${image.width}x${image.height}`,
    limit: `${bounds.minWidth}x${bounds.minHeight} to ${bounds.maxWidth}x${bounds.maxHeight}`,
  });
  // Main white images need at least 1600 px on the longest side. The spec's
  // own minLongSide wins when set (the registry's amazon.main already says
  // 1600); the constant is the fallback for main class specs that omit it.
  const minLong =
    spec.minLongSide ?? (kind === "main" ? QC_THRESHOLDS.main.minLongSide : bounds.minLongSide);
  checks.push({
    name: "longestSide",
    pass: longestSide >= minLong && longestSide <= bounds.maxLongSide,
    measured: longestSide,
    limit: `${minLong} to ${bounds.maxLongSide}`,
  });

  // Background white share outside the (margin dilated) mask.
  let backgroundWhiteShare: number | null = null;
  if (mask && spec.background?.type === "solid" && spec.background.rgb) {
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
    const required =
      kind === "main" ? QC_THRESHOLDS.main.backgroundWhiteShareAfterForcing : 0.999;
    checks.push({
      name: "backgroundWhiteShare",
      pass: backgroundWhiteShare >= required,
      measured: backgroundWhiteShare,
      limit: `>= ${required}`,
    });
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
    const fillMin = spec.fill?.min ?? (kind === "main" ? QC_THRESHOLDS.main.fillMin : null);
    const fillMax = spec.fill?.max ?? (kind === "main" ? QC_THRESHOLDS.main.fillMax : null);
    if (fillMin !== null && fillMax !== null) {
      checks.push({
        name: "fillRatio",
        pass: fillRatio >= fillMin && fillRatio <= fillMax,
        measured: fillRatio,
        limit: `${fillMin} to ${fillMax}`,
      });
    }
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
