import { describe, expect, it } from "vitest";
import type { StoredFidelity } from "@curvi/pipeline/fidelity-record";
import { identityClaims, unqualifiedClaims } from "@/lib/marketing-facts";
import { buildComplianceReportView, describeCheck } from "./compliance-report";
import { renderComplianceReportPdf } from "./compliance-pdf";
import {
  badgeFidelitySentence,
  complianceBadgeText,
  DEMO_PROOF_NOTE,
  fidelityNote,
  GENERATED_CAPTION,
  KEPT_BYTE_FOR_BYTE_NOTE,
  NOT_REDRAWN_NOTE,
  PRODUCT_NOT_REDRAWN_LABEL,
  productUnchangedMeasured,
  productUnchangedRequired,
  SCENE_CAPTION,
  SHARE_PROOF_HEADING,
  SHARE_PROOF_HINT,
  SHARE_PROOF_INTRO,
  SHARE_PROOF_TOGGLE,
  shareProductUnchangedRow,
} from "./proof-copy";

// P18-08 and P18-16 copy: CLAUDE.md rule 9 (no emojis, no arrows, no dashes
// as punctuation), the claims guard, and the measured rows on every surface.

const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}|>=|<=/u;

const fidelity: StoredFidelity = {
  meanDeltaE: 0.84,
  maxDeltaE: 3.2,
  exactByteShare: 0.4123,
  maskArea: 52000,
  threshold: 3,
  maxDeltaELimit: 10,
  kind: "main",
  exact: false,
};

const kept: StoredFidelity = { ...fidelity, meanDeltaE: 0, maxDeltaE: 0, exactByteShare: 1, exact: true };

function allCopy(): string[] {
  return [
    PRODUCT_NOT_REDRAWN_LABEL,
    productUnchangedMeasured(fidelity),
    productUnchangedRequired(fidelity),
    NOT_REDRAWN_NOTE,
    KEPT_BYTE_FOR_BYTE_NOTE,
    badgeFidelitySentence(fidelity),
    complianceBadgeText({ fillPct: 87, background: [255, 255, 255], fidelity }),
    SHARE_PROOF_TOGGLE,
    SHARE_PROOF_HINT,
    SHARE_PROOF_HEADING,
    SHARE_PROOF_INTRO,
    shareProductUnchangedRow(fidelity),
    SCENE_CAPTION,
    GENERATED_CAPTION,
    DEMO_PROOF_NOTE,
  ];
}

describe("proof copy", () => {
  it("is plain spoken: no emojis, arrows, dashes as punctuation or raw operators", () => {
    for (const text of allCopy()) {
      expect(text, text).not.toMatch(FORBIDDEN_COPY);
    }
  });

  it("claims nothing that is coming soon, and no product identity (P18-09)", () => {
    for (const text of allCopy()) {
      expect(unqualifiedClaims(text), text).toEqual([]);
      expect(identityClaims(text), text).toEqual([]);
    }
    // The plan's first label was itself an identity claim beside numbers
    // that show a small color change.
    expect(identityClaims("Product unchanged: average color difference 2.91, limit 3")).not.toEqual([]);
  });

  it("never calls a resized file identical, and says byte for byte only for a kept photo", () => {
    for (const text of allCopy()) {
      expect(text).not.toMatch(/identical|exactly/i);
    }
    expect(fidelityNote(fidelity)).toBe(NOT_REDRAWN_NOTE);
    expect(fidelityNote(kept)).toBe(KEPT_BYTE_FOR_BYTE_NOTE);
  });

  it("states the plan's wording with the measured numbers", () => {
    expect(productUnchangedMeasured(fidelity)).toBe("Average color difference 0.84, largest 3.2");
    expect(productUnchangedRequired(fidelity)).toBe("Average at most 3, no pixel above 10");
    expect(shareProductUnchangedRow(fidelity)).toBe("Product not redrawn: average color difference 0.84, limit 3");
  });
});

describe("the pack page badge", () => {
  it("adds the product not redrawn sentence after the fill", () => {
    expect(complianceBadgeText({ fillPct: 87, background: null, fidelity })).toBe(
      "Passes channel rules. Fill 87 percent. Product not redrawn: 0.84 average color difference.",
    );
    expect(complianceBadgeText({ fillPct: 87, background: [255, 255, 255], fidelity })).toBe(
      "Passes channel rules. Fill 87 percent, background 255, 255, 255. Product not redrawn: 0.84 average color difference.",
    );
  });

  it("reads as before when nothing was measured", () => {
    expect(complianceBadgeText({ fillPct: 87, background: null, fidelity: null })).toBe("Passes channel rules. Fill 87 percent");
    expect(complianceBadgeText({ fillPct: null, background: null })).toBe("Passes channel rules");
    expect(complianceBadgeText({ fillPct: null, background: null, fidelity })).toBe(
      "Passes channel rules. Product not redrawn: 0.84 average color difference.",
    );
  });
});

const meta = { jobId: "00000000-0000-4000-8000-00000000a018", productTitle: "Amber candle" };

// Shaped like packages/pipeline buildPack's report, version 2.
const stored = {
  version: 2,
  generatedAt: "2026-10-01T12:00:00.000Z",
  files: [
    {
      file: "SKU1.PT01.jpg",
      channel: "amazon",
      specId: "amazon.secondary",
      ref: "s01",
      digitalSource: "composite",
      notes: ["iptc digital source type: composite"],
      checks: [
        { name: "dimensions", pass: true, measured: "2000x2000", limit: "1x1 to 2000x2000" },
        { name: "product_unchanged", pass: true, measured: 0.84, limit: "<= 3" },
      ],
      fidelity,
      pass: true,
    },
    {
      file: "SKU1.PT02.jpg",
      channel: "amazon",
      specId: "amazon.secondary",
      ref: "s02",
      digitalSource: "none",
      notes: ["original: kept as uploaded, unchanged file"],
      checks: [{ name: "product_unchanged", pass: true, measured: 0, limit: "<= 3" }],
      fidelity: kept,
      pass: true,
    },
    {
      // A report written before Phase 18: no row, no note.
      file: "SKU1.PT03.jpg",
      channel: "amazon",
      specId: "amazon.secondary",
      checks: [{ name: "dimensions", pass: true, measured: "2000x2000", limit: "1x1 to 2000x2000" }],
      pass: true,
    },
  ],
  dropped: [],
};

describe("the report and PDF rows", () => {
  it("renders Product not redrawn from the file's numbers, with the note", () => {
    const view = buildComplianceReportView(stored, meta)!;
    const [scene, keptFile, older] = view.channels[0].files;
    expect(scene.checks.at(-1)).toEqual({
      key: "product_unchanged",
      label: "Product not redrawn",
      pass: true,
      measured: "Average color difference 0.84, largest 3.2",
      required: "Average at most 3, no pixel above 10",
    });
    expect(scene.notes).toContain(NOT_REDRAWN_NOTE);
    expect(keptFile.checks[0].measured).toBe("Average color difference 0, largest 0");
    expect(keptFile.notes).toContain(KEPT_BYTE_FOR_BYTE_NOTE);
    expect(keptFile.notes).not.toContain(NOT_REDRAWN_NOTE);
    expect(older.checks.map((c) => c.key)).toEqual(["dimensions"]);
    expect(older.notes).toEqual([]);
  });

  it("states the row from the check alone when the numbers are missing", () => {
    expect(describeCheck({ name: "product_unchanged", pass: true, measured: 1.2, limit: "<= 5" })).toEqual({
      key: "product_unchanged",
      label: "Product not redrawn",
      pass: true,
      measured: "Average color difference 1.2",
      required: "Average at most 5",
    });
  });

  it("ignores a malformed fidelity entry instead of failing the report", () => {
    const view = buildComplianceReportView(
      { ...stored, files: [{ ...stored.files[0], fidelity: { meanDeltaE: "low" } }] },
      meta,
    )!;
    const file = view.channels[0].files[0];
    expect(file.checks.at(-1)?.measured).toBe("Average color difference 0.84");
    expect(file.notes).not.toContain(NOT_REDRAWN_NOTE);
  });

  it("prints the row and the note in the PDF", () => {
    const text = renderComplianceReportPdf(buildComplianceReportView(stored, meta)!).toString("latin1");
    expect(text).toContain(
      "Product not redrawn: Average color difference 0.84, largest 3.2. Required: Average at most 3, no pixel above 10.",
    );
    expect(text).toContain("Not redrawn by AI. Measured on this exact file, inside your product.");
    expect(text).toContain("Every pixel of your photo kept byte for byte.");
  });
});
