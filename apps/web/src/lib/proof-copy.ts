/**
 * Copy for the measured product fidelity (docs/phases/PHASE_18.md P18-08 and
 * P18-16): the "Product not redrawn" row of the compliance report and its PDF,
 * the pack page badge, and the public proof panel on share pages. One module,
 * so every surface states the same numbers in the same words, and one lint
 * test (proof-copy.test.ts) holds it to CLAUDE.md rule 9 and the claims guard.
 *
 * The numbers are CIEDE2000 color differences measured inside the product on
 * the delivered file. The copy says what was measured and never more: most
 * resized files are not byte for byte copies, and only a kept photo shipped
 * as uploaded is described that way.
 *
 * The row is labeled "Product not redrawn" (claim C-01), not the plan's
 * "Product unchanged": a resized file's product does change a little, which
 * is what the numbers next to it show, and identityClaims() in
 * lib/marketing-facts.ts rejects "unchanged" about a product (P18-09). The
 * machine readable check keeps its name, product_unchanged, in
 * compliance-report.json.
 */

import type { StoredFidelity } from "@curvi/pipeline/fidelity-record";

/** A measured number as plain text: 0.84, 3, 1.5. */
export function proofNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** The row label on the report, the PDF, the badge and share pages. */
export const PRODUCT_NOT_REDRAWN_LABEL = "Product not redrawn";

/** The report row's measured column. */
export function productUnchangedMeasured(fidelity: Pick<StoredFidelity, "meanDeltaE" | "maxDeltaE">): string {
  return `Average color difference ${proofNumber(fidelity.meanDeltaE)}, largest ${proofNumber(fidelity.maxDeltaE)}`;
}

/** The report row's required column. */
export function productUnchangedRequired(fidelity: Pick<StoredFidelity, "threshold" | "maxDeltaELimit">): string {
  return `Average at most ${proofNumber(fidelity.threshold)}, no pixel above ${proofNumber(fidelity.maxDeltaELimit)}`;
}

/** The report row when only the stored check survives (no fidelity entry). */
export function productUnchangedMeasuredMean(mean: number): string {
  return `Average color difference ${proofNumber(mean)}`;
}

export function productUnchangedRequiredMean(threshold: number): string {
  return `Average at most ${proofNumber(threshold)}`;
}

/** The note under a file with measured numbers. */
export const NOT_REDRAWN_NOTE = "Not redrawn by AI. Measured on this exact file, inside your product.";

/** The note under a kept photo shipped as the seller uploaded it. */
export const KEPT_BYTE_FOR_BYTE_NOTE = "Every pixel of your photo kept byte for byte.";

/** The note a file's fidelity record earns. */
export function fidelityNote(fidelity: Pick<StoredFidelity, "exact">): string {
  return fidelity.exact ? KEPT_BYTE_FOR_BYTE_NOTE : NOT_REDRAWN_NOTE;
}

/** The pack page badge sentence: "Product not redrawn: 0.84 average color difference." */
export function badgeFidelitySentence(fidelity: Pick<StoredFidelity, "meanDeltaE">): string {
  return `${PRODUCT_NOT_REDRAWN_LABEL}: ${proofNumber(fidelity.meanDeltaE)} average color difference.`;
}

/**
 * The pack page's green badge for a shot that passed, from its measured
 * compliance: "Passes channel rules. Fill 87 percent. Product not redrawn: 0.84
 * average color difference." Background is shown only where the board
 * shows it today (never on a kept photo).
 */
export function complianceBadgeText(compliance: {
  fillPct: number | null;
  background: readonly [number, number, number] | null;
  fidelity?: Pick<StoredFidelity, "meanDeltaE"> | null;
}): string {
  const { fillPct, background, fidelity } = compliance;
  let text = "Passes channel rules";
  if (fillPct !== null && background) {
    text += `. Fill ${fillPct} percent, background ${background.join(", ")}`;
  } else if (fillPct !== null) {
    text += `. Fill ${fillPct} percent`;
  }
  return fidelity ? `${text}. ${badgeFidelitySentence(fidelity)}` : text;
}

// Share pages (P18-16).

/** The share panel toggle. */
export const SHARE_PROOF_TOGGLE = "Show the measured checks on the public page";

/** What the toggle does, under it. */
export const SHARE_PROOF_HINT =
  "Each image shows its channel, the checks it passed and how little the color inside your product changed. No file names or account details are shown.";

/** The public proof panel heading. */
export const SHARE_PROOF_HEADING = "Measured on every file";

/** The public proof panel's intro line. */
export const SHARE_PROOF_INTRO =
  "Curvi checks every file against its channel's image rules and measures the color inside the product on the finished file.";

/** The public row: "Product not redrawn: average color difference 0.84, limit 3". */
export function shareProductUnchangedRow(fidelity: Pick<StoredFidelity, "meanDeltaE" | "threshold">): string {
  return `${PRODUCT_NOT_REDRAWN_LABEL}: average color difference ${proofNumber(fidelity.meanDeltaE)}, limit ${proofNumber(fidelity.threshold)}`;
}

/** The caption on a composited scene, which keeps a public copy disclosed
 * after the share image dropped the file's AI label. */
export const SCENE_CAPTION = "Scene made with AI around the real product";

/** The caption on a fully generated image (concept mode). */
export const GENERATED_CAPTION = "Image made with AI";

/** Shown instead of measured values on a demo share page. */
export const DEMO_PROOF_NOTE = "Demo mode lists the checks each file gets. Real share pages show the measured values.";
