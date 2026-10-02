/**
 * The measured proof of one delivered file, as the pack page's "See the
 * proof" and a public share page's proof panel show it (docs/phases/
 * PHASE_18.md P18-16). Built from what the runner stores on the asset row
 * (qc.outputs, P18-08), worded by the same describeCheck the compliance
 * report uses, so both pages state the same numbers in the same words.
 *
 * Pure and client safe. It reads only the asset's stored numbers and check
 * rows: no object key, workspace id, file name or metadata ever enters a
 * view, which is what lets a public page show it.
 */

import {
  readStoredFidelity,
  readStoredOutputProofs,
  type StoredOutputProof,
} from "@curvi/pipeline/fidelity-record";
import { specDisplayName } from "@/components/marketing/spec-slug";
import { describeCheck, specRequirementChecks } from "@/lib/compliance-report";
import { fidelityNote, GENERATED_CAPTION, SCENE_CAPTION, shareProductUnchangedRow } from "@/lib/proof-copy";
import { getSpec, hasSpec } from "@curvi/specs";

/** One proof row: what was checked, what was measured, what the channel requires. */
export interface ProofRowView {
  key: string;
  label: string;
  measured: string;
  required: string;
  /** Null when nothing was measured (a demo page lists the checks only). */
  pass: boolean | null;
}

export interface FileProofView {
  /** The channel spec the file was made for. */
  specId: string;
  /** Its readable name, e.g. "Amazon main image". */
  channel: string;
  /** Size, background and fill rows, as QC measured them on the file. */
  rows: ProofRowView[];
  /** "Product not redrawn: average color difference 0.84, limit 3", or null
   * when the file was not measured against the product. */
  productUnchanged: string | null;
  /** The note under the numbers: not redrawn, or kept byte for byte. */
  note: string | null;
  /** "Scene made with AI around the real product" on a composited scene,
   * "Image made with AI" on a fully generated one; null otherwise. */
  caption: string | null;
}

/** The order the rows read in: size, then background, then fill. */
const ROW_ORDER = ["dimensions", "backgroundWhiteShare", "backgroundWhiteOrClear", "fillRatio"];

/** The caption a file's IPTC digital source kind earns. */
export function captionFor(digitalSource: unknown): string | null {
  if (digitalSource === "composite") {
    return SCENE_CAPTION;
  }
  if (digitalSource === "trained") {
    return GENERATED_CAPTION;
  }
  return null;
}

/** The proof view of one stored output. */
export function fileProofView(entry: StoredOutputProof, digitalSource: unknown): FileProofView {
  const rows = entry.checks
    .filter((check) => ROW_ORDER.includes(check.name))
    .sort((a, b) => ROW_ORDER.indexOf(a.name) - ROW_ORDER.indexOf(b.name))
    .map((check) => {
      const view = describeCheck(check, entry.specId);
      return { key: view.key, label: view.label, measured: view.measured, required: view.required, pass: view.pass };
    });
  return {
    specId: entry.specId,
    channel: specDisplayName(entry.specId),
    rows,
    productUnchanged: entry.fidelity ? shareProductUnchangedRow(entry.fidelity) : null,
    note: entry.fidelity ? fidelityNote(entry.fidelity) : null,
    caption: captionFor(digitalSource),
  };
}

/** Every passed output's proof stored on an asset row (qc.outputs). Empty
 * for rows made before Phase 18. */
export function fileProofsFromQc(qc: Record<string, unknown> | null | undefined): FileProofView[] {
  if (!qc) {
    return [];
  }
  return readStoredOutputProofs(qc.outputs).map((entry) => fileProofView(entry, qc.digitalSource));
}

/**
 * The proof of the file a page shows for one shot: the stored output for
 * that file's spec. An asset saved before qc.outputs existed falls back to
 * its representative record when the spec matches, else shows the channel
 * and caption only.
 */
export function proofForFile(qc: Record<string, unknown> | null | undefined, specId: string): FileProofView {
  const stored = readStoredOutputProofs(qc?.outputs).find((entry) => entry.specId === specId);
  if (stored) {
    return fileProofView(stored, qc?.digitalSource);
  }
  const fidelity = qc?.specId === specId ? readStoredFidelity(qc?.fidelity) : null;
  return fileProofView({ specId, fidelity, checks: [] }, qc?.digitalSource);
}

/**
 * A demo page's proof: the checks the spec holds each file to, with nothing
 * measured (demo packs store no files), and the caption the shot earns.
 */
export function demoProofView(specId: string, composite: boolean): FileProofView {
  const rows: ProofRowView[] = hasSpec(specId)
    ? specRequirementChecks(getSpec(specId))
        .filter((row) => ROW_ORDER.includes(row.key))
        .map((row) => ({ ...row, pass: null }))
    : [];
  return {
    specId,
    channel: specDisplayName(specId),
    rows,
    productUnchanged: null,
    note: null,
    caption: composite ? SCENE_CAPTION : null,
  };
}
