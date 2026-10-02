/**
 * The fidelity numbers a delivered file keeps (docs/phases/PHASE_18.md
 * P18-08). fidelityReport measures the color inside the product on the
 * bytes that ship; before Phase 18 only pass or fail survived. This module
 * turns a report into the small, rounded record that is stored on the asset
 * row (assets.qc.fidelity), written into compliance-report.json and served
 * by the API, and reads that record back leniently.
 *
 * Pure and free of sharp and node imports, so the web app can import it
 * through @curvi/pipeline/fidelity-record on any page.
 */

import type { CheckItem, QcKind } from "./pixelChecks";

/** What one delivered file proves about the product inside it. */
export interface StoredFidelity {
  /** Mean CIEDE2000 inside the eroded product mask, to 2 decimals. */
  meanDeltaE: number;
  /** Largest single pixel CIEDE2000 there, to 1 decimal. */
  maxDeltaE: number;
  /** Share of compared pixels whose bytes match exactly, to 4 decimals. */
  exactByteShare: number;
  /** Pixels compared. */
  maskArea: number;
  /** The mean the file had to stay under: 3 for main images, 5 for the rest. */
  threshold: number;
  /** The single pixel ceiling it had to stay under. */
  maxDeltaELimit: number;
  kind: QcKind;
  /** True only when the delivered file is the seller's upload byte for byte
   * (a kept photo shipped unchanged, proven by its sha256). */
  exact: boolean;
}

/** The fields of a FidelityReport this record reads. */
export interface FidelityReportLike {
  meanDeltaE: number;
  maxDeltaE: number;
  exactByteShare: number;
  maskArea: number;
  threshold: number;
  maxDeltaELimit: number;
  kind: QcKind;
}

/** The check name the packager writes for the fidelity row. */
export const PRODUCT_UNCHANGED_CHECK = "product_unchanged";

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * The stored record of a fidelity report, rounded: mean to 2 decimals, max
 * to 1, share to 4. Null when the report measured nothing (no compared
 * pixels) or holds a value that is not a finite number, since such a report
 * proves nothing and never passes.
 */
export function storedFidelityOf(report: FidelityReportLike | null | undefined): StoredFidelity | null {
  if (!report) {
    return null;
  }
  const { meanDeltaE, maxDeltaE, exactByteShare, maskArea, threshold, maxDeltaELimit } = report;
  if (
    ![meanDeltaE, maxDeltaE, exactByteShare, maskArea, threshold, maxDeltaELimit].every(Number.isFinite) ||
    maskArea <= 0
  ) {
    return null;
  }
  return {
    meanDeltaE: round(meanDeltaE, 2),
    maxDeltaE: round(maxDeltaE, 1),
    exactByteShare: round(exactByteShare, 4),
    maskArea: Math.round(maskArea),
    threshold,
    maxDeltaELimit,
    kind: report.kind,
    exact: false,
  };
}

/**
 * The record of a kept photo shipped as the stored upload: the delivered
 * bytes equal the upload's sha256, so every pixel of the photo matches.
 */
export function passthroughFidelity(
  pixels: number,
  limits: { threshold: number; maxDeltaELimit: number },
): StoredFidelity | null {
  if (!Number.isFinite(pixels) || pixels <= 0) {
    return null;
  }
  return {
    meanDeltaE: 0,
    maxDeltaE: 0,
    exactByteShare: 1,
    maskArea: Math.round(pixels),
    threshold: limits.threshold,
    maxDeltaELimit: limits.maxDeltaELimit,
    kind: "main",
    exact: true,
  };
}

/** True when the record is inside both of its limits. */
export function fidelityRecordPasses(fidelity: StoredFidelity): boolean {
  return fidelity.meanDeltaE <= fidelity.threshold && fidelity.maxDeltaE <= fidelity.maxDeltaELimit;
}

/**
 * The fidelity row of a file's compliance report: measured is the mean,
 * limit the threshold, as the other rows write theirs.
 */
export function productUnchangedCheck(fidelity: StoredFidelity): CheckItem {
  return {
    name: PRODUCT_UNCHANGED_CHECK,
    pass: fidelityRecordPasses(fidelity),
    measured: fidelity.meanDeltaE,
    limit: `<= ${fidelity.threshold}`,
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Reads a stored record back (assets.qc.fidelity, a report file's fidelity,
 * an API body). Null for anything that is not a whole record, so older
 * rows and hand edited JSON simply show no fidelity row.
 */
export function readStoredFidelity(value: unknown): StoredFidelity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const meanDeltaE = finiteNumber(raw.meanDeltaE);
  const maxDeltaE = finiteNumber(raw.maxDeltaE);
  const exactByteShare = finiteNumber(raw.exactByteShare);
  const maskArea = finiteNumber(raw.maskArea);
  const threshold = finiteNumber(raw.threshold);
  const maxDeltaELimit = finiteNumber(raw.maxDeltaELimit);
  if (
    meanDeltaE === null ||
    maxDeltaE === null ||
    exactByteShare === null ||
    maskArea === null ||
    threshold === null ||
    maxDeltaELimit === null ||
    (raw.kind !== "main" && raw.kind !== "other")
  ) {
    return null;
  }
  return {
    meanDeltaE,
    maxDeltaE,
    exactByteShare,
    maskArea,
    threshold,
    maxDeltaELimit,
    kind: raw.kind,
    exact: raw.exact === true,
  };
}

/** The pixel check rows a public proof shows for a file: its size, its
 * background and its product fill (P18-16). */
export const PROOF_CHECK_NAMES: readonly string[] = [
  "dimensions",
  "backgroundWhiteShare",
  "backgroundWhiteOrClear",
  "fillRatio",
];

/** What a delivered channel output proves, as the asset row stores it in
 * qc.outputs: its spec, its fidelity record and its proof check rows. */
export interface StoredOutputProof {
  specId: string;
  fidelity: StoredFidelity | null;
  checks: CheckItem[];
}

function readCheck(value: unknown): CheckItem | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || typeof raw.pass !== "boolean") {
    return null;
  }
  const measured =
    typeof raw.measured === "number" || typeof raw.measured === "string" || raw.measured === null
      ? raw.measured
      : null;
  return { name: raw.name, pass: raw.pass, measured, limit: typeof raw.limit === "string" ? raw.limit : "" };
}

/** Reads assets.qc.outputs back; entries that are not whole are left out. */
export function readStoredOutputProofs(value: unknown): StoredOutputProof[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: StoredOutputProof[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const raw = entry as Record<string, unknown>;
    if (typeof raw.specId !== "string") {
      continue;
    }
    const checks = Array.isArray(raw.checks)
      ? raw.checks.map(readCheck).filter((c): c is CheckItem => c !== null)
      : [];
    out.push({ specId: raw.specId, fidelity: readStoredFidelity(raw.fidelity), checks });
  }
  return out;
}
