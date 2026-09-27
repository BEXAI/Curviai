/**
 * Product fidelity report: asserts that pixels inside the eroded product mask
 * are unchanged between the original and the composed output. This is the
 * enforcement point for CLAUDE.md rule 3: product pixels inside the mask are
 * never regenerated for Listing Mode outputs.
 */
import { ciede2000, rgbToLab } from "../color";
import { erode } from "../mask";
import type { RawImage, RawMask } from "../raw";
import { QC_THRESHOLDS, type QcKind } from "./pixelChecks";

export interface FidelityReport {
  /** Pixels compared, after erosion. */
  maskArea: number;
  /** Share of compared pixels whose RGB bytes match exactly. */
  exactByteShare: number;
  /** Mean CIEDE2000 over the compared pixels. */
  meanDeltaE: number;
  /** Largest single pixel CIEDE2000 seen. */
  maxDeltaE: number;
  erodePx: number;
  kind: QcKind;
  threshold: number;
  pass: boolean;
}

export interface FidelityOptions {
  /** How far to shrink the mask before comparing. Default 3. */
  erodePx?: number;
  /** Which threshold row applies: main 3.0, others 5.0. Default main. */
  kind?: QcKind;
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

  const erodePx = opts.erodePx ?? 3;
  const kind = opts.kind ?? "main";
  const eroded = await erode(mask, erodePx);

  let area = 0;
  let exact = 0;
  let sumDeltaE = 0;
  let maxDeltaE = 0;
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
    sumDeltaE += d;
    if (d > maxDeltaE) {
      maxDeltaE = d;
    }
  }

  const meanDeltaE = area === 0 ? 0 : sumDeltaE / area;
  const threshold = QC_THRESHOLDS[kind].maxMeanDeltaE;
  return {
    maskArea: area,
    exactByteShare: area === 0 ? 1 : exact / area,
    meanDeltaE,
    maxDeltaE,
    erodePx,
    kind,
    threshold,
    pass: meanDeltaE <= threshold,
  };
}
