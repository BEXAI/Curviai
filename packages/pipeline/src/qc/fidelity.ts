/**
 * Product fidelity report: asserts that pixels inside the eroded product mask
 * are unchanged between the original and the composed output. This is the
 * enforcement point for CLAUDE.md rule 3: product pixels inside the mask are
 * never regenerated for Listing Mode outputs.
 */
import { ciede2000, rgbToLab } from "../color";
import { PASTE_ERODE_PX, PASTE_FEATHER_PX } from "../composite/index";
import { erode } from "../mask";
import type { RawImage, RawMask } from "../raw";
import { QC_THRESHOLDS, type QcKind } from "./pixelChecks";

/**
 * Default single pixel CIEDE2000 ceiling inside the QC region. A tiny mean
 * over a large region must not hide extreme local drift (a leaked band of
 * regenerated pixels).
 */
export const DEFAULT_MAX_DELTA_E_LIMIT = 10;

/**
 * The QC check region must sit STRICTLY inside the pure paste region of the
 * composite. Paste back uses erode P plus feather F, and the feather ramps
 * outward from the eroded boundary, so QC must erode by at least
 * P + ceil(F) + 1 to stay clear of any blended pixel. This is the derived
 * default erosion for fidelityReport; callers that pasted with other
 * parameters (or with an adaptively clamped radius, see
 * CompositeResult.effectivePasteErodePx) derive their own value here.
 */
export function deriveQcErodePx(
  pasteErodePx: number = PASTE_ERODE_PX,
  pasteFeatherPx: number = PASTE_FEATHER_PX,
): number {
  return Math.max(0, Math.floor(pasteErodePx)) + Math.ceil(Math.max(0, pasteFeatherPx)) + 1;
}

export type FidelityIssue =
  | "invalid_input"
  | "input_mask_empty"
  | "eroded_mask_empty"
  | "non_finite_delta_e"
  | "mean_delta_e_exceeded"
  | "max_delta_e_exceeded"
  | "not_exact";

export interface FidelityReport {
  /** Pixels compared, after erosion. */
  maskArea: number;
  /** Nonzero pixels in the input mask, before erosion. */
  inputMaskArea: number;
  /** Share of compared pixels whose RGB bytes match exactly. 0 when nothing was compared. */
  exactByteShare: number;
  /** Mean CIEDE2000 over the compared pixels. */
  meanDeltaE: number;
  /** Largest single pixel CIEDE2000 seen. */
  maxDeltaE: number;
  erodePx: number;
  kind: QcKind;
  threshold: number;
  /** Single pixel CIEDE2000 ceiling enforced inside the QC region. */
  maxDeltaELimit: number;
  /** Empty when the report passes. */
  issues: FidelityIssue[];
  /** Why the input was rejected, present only with the invalid_input issue. */
  invalidReason?: string;
  pass: boolean;
}

export interface FidelityOptions {
  /**
   * How far to shrink the mask before comparing. Default deriveQcErodePx(),
   * strictly inside the composite paste region at its default parameters.
   */
  erodePx?: number;
  /** Which threshold row applies: main 3.0, others 5.0. Default main. */
  kind?: QcKind;
  /** Single pixel CIEDE2000 ceiling. Default DEFAULT_MAX_DELTA_E_LIMIT. */
  maxDeltaELimit?: number;
  /**
   * Require every compared pixel to match byte for byte. For a render whose
   * reference went through the same operations before any encoding (a kept
   * photo, PHASE_15), any difference at all is drift: a 2 percent
   * brightness change stays under the deltaE rows but fails here.
   */
  exact?: boolean;
}

export async function fidelityReport(
  original: RawImage,
  composed: RawImage,
  mask: RawMask,
  opts: FidelityOptions = {},
): Promise<FidelityReport> {
  if (original.width !== composed.width || original.height !== composed.height) {
    throw new Error(
      `Original ${original.width}x${original.height} and composed ${composed.width}x${composed.height} must match`,
    );
  }
  if (mask.width !== original.width || mask.height !== original.height) {
    throw new Error("Mask dimensions must match the images");
  }

  const erodePx = opts.erodePx ?? deriveQcErodePx();
  const kind = opts.kind ?? "main";
  const maxDeltaELimit = opts.maxDeltaELimit ?? DEFAULT_MAX_DELTA_E_LIMIT;
  const threshold = QC_THRESHOLDS[kind].maxMeanDeltaE;

  // Fail closed on malformed input. A short buffer reads undefined bytes,
  // which turn every deltaE into NaN, and NaN is never greater than a
  // threshold: the old code passed such a report.
  const invalid = invalidInputReason(original, composed, mask, erodePx, maxDeltaELimit);
  if (invalid) {
    return {
      maskArea: 0,
      inputMaskArea: 0,
      exactByteShare: 0,
      meanDeltaE: Number.NaN,
      maxDeltaE: Number.NaN,
      erodePx,
      kind,
      threshold,
      maxDeltaELimit,
      issues: ["invalid_input"],
      invalidReason: invalid,
      pass: false,
    };
  }

  const eroded = await erode(mask, erodePx);

  // Same binary convention as erode(): values at or above 128 are product.
  let inputMaskArea = 0;
  for (let i = 0; i < mask.data.length; i++) {
    if (mask.data[i] >= 128) {
      inputMaskArea++;
    }
  }

  let area = 0;
  let exact = 0;
  let sumDeltaE = 0;
  let maxDeltaE = 0;
  let nonFinite = false;
  for (let i = 0; i < eroded.data.length; i++) {
    if (eroded.data[i] === 0) {
      continue;
    }
    area++;
    const o = i * 4;
    const r1 = original.data[o];
    const g1 = original.data[o + 1];
    const b1 = original.data[o + 2];
    const r2 = composed.data[o];
    const g2 = composed.data[o + 1];
    const b2 = composed.data[o + 2];
    if (r1 === r2 && g1 === g2 && b1 === b2) {
      exact++;
      continue;
    }
    const d = ciede2000(rgbToLab(r1, g1, b1), rgbToLab(r2, g2, b2));
    if (!Number.isFinite(d)) {
      nonFinite = true;
      continue;
    }
    sumDeltaE += d;
    if (d > maxDeltaE) {
      maxDeltaE = d;
    }
  }

  const meanDeltaE = nonFinite ? Number.NaN : area === 0 ? 0 : sumDeltaE / area;
  if (nonFinite) {
    maxDeltaE = Number.NaN;
  }

  // A vacuous comparison must never pass: an empty QC region proves nothing
  // about product fidelity, so it fails with an explicit issue instead of
  // reporting perfect scores. A NaN or infinite deltaE fails explicitly,
  // since no threshold comparison can catch it.
  const issues: FidelityIssue[] = [];
  if (inputMaskArea === 0) {
    issues.push("input_mask_empty");
  } else if (area === 0) {
    issues.push("eroded_mask_empty");
  } else if (!Number.isFinite(meanDeltaE) || !Number.isFinite(maxDeltaE)) {
    issues.push("non_finite_delta_e");
  } else {
    if (meanDeltaE > threshold) {
      issues.push("mean_delta_e_exceeded");
    }
    if (maxDeltaE > maxDeltaELimit) {
      issues.push("max_delta_e_exceeded");
    }
    if (opts.exact && exact !== area) {
      issues.push("not_exact");
    }
  }

  return {
    maskArea: area,
    inputMaskArea,
    exactByteShare: area === 0 ? 0 : exact / area,
    meanDeltaE,
    maxDeltaE,
    erodePx,
    kind,
    threshold,
    maxDeltaELimit,
    issues,
    pass: issues.length === 0,
  };
}

/** Why these buffers cannot be compared, or null when they are well formed. */
function invalidInputReason(
  original: RawImage,
  composed: RawImage,
  mask: RawMask,
  erodePx: number,
  maxDeltaELimit: number,
): string | null {
  const { width, height } = original;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return `image size ${width}x${height} is not a positive whole number of pixels`;
  }
  const pixels = width * height;
  if (original.data.length !== pixels * 4) {
    return `original holds ${original.data.length} bytes, expected ${pixels * 4}`;
  }
  if (composed.data.length !== pixels * 4) {
    return `composed holds ${composed.data.length} bytes, expected ${pixels * 4}`;
  }
  if (mask.data.length !== pixels) {
    return `mask holds ${mask.data.length} bytes, expected ${pixels}`;
  }
  if (!Number.isFinite(erodePx) || erodePx < 0) {
    return `erosion ${erodePx} is not a finite non negative number`;
  }
  if (!Number.isFinite(maxDeltaELimit) || maxDeltaELimit < 0) {
    return `max deltaE limit ${maxDeltaELimit} is not a finite non negative number`;
  }
  return null;
}
