/**
 * The A+ modules in the web app (docs/phases/PHASE_16.md workstream 2): the
 * endorsements seller input (validation, the form's check, the worker
 * payload), the estimate lines and hold, and the board copy for every
 * module reason, held to rule 9.
 */
import { describe, expect, it } from "vitest";
import {
  APLUS_CLAIMS_FLAG_REASON,
  APLUS_COPY_SHORT_REASON,
  APLUS_MODULE_CAP_REASON,
  APLUS_NO_FACTS_REASON,
  NO_ENDORSEMENT_REASON,
} from "@curvi/pipeline/aplus";
import { rule9Problems } from "@curvi/pipeline";
import { creditCosts } from "@curvi/pipeline/seed";
import { MAX_ENDORSEMENTS, MAX_SELLER_LINE_CHARS } from "@curvi/pipeline/seller-inputs";
import { sellerDetailsProblem } from "@/components/app/new-pack-form";
import { buildGeneratePackInput } from "@/lib/jobs/payload";
import { NO_ENDORSEMENT_COPY, skippedCopy } from "@/lib/job-copy";
import { shotTypeLabel } from "@/lib/library";
import { estimatePackCredits } from "@/lib/pack-estimate";
import { endorsementLinesSchema } from "@/lib/validation/seller-inputs";

describe("endorsements seller input", () => {
  it("takes up to three short lines and refuses more or longer, never cutting one", () => {
    expect(endorsementLinesSchema.parse(["  Loved by  hikers ", "Gift Guide pick 2026"])).toEqual([
      "Loved by hikers",
      "Gift Guide pick 2026",
    ]);
    expect(endorsementLinesSchema.safeParse(["a", "b", "c", "d"]).success).toBe(false);
    expect(endorsementLinesSchema.safeParse(["x".repeat(MAX_SELLER_LINE_CHARS + 1)]).success).toBe(false);
    expect(MAX_ENDORSEMENTS).toBe(3);
  });

  it("tells the seller the fix in the form before the API refuses it", () => {
    expect(sellerDetailsProblem("", [], [], ["Loved by hikers"])).toBeNull();
    expect(sellerDetailsProblem("", [], [], ["a", "b", "c", "d"])).toBe("List at most 3 quotes or awards.");
    const long = "y".repeat(MAX_SELLER_LINE_CHARS + 1);
    expect(sellerDetailsProblem("", [], [], [long])).toContain("Keep each quote or award to");
    for (const problem of [
      sellerDetailsProblem("", [], [], ["a", "b", "c", "d"]),
      sellerDetailsProblem("", [], [], [long]),
    ]) {
      expect(rule9Problems(problem ?? "")).toEqual([]);
    }
  });

  it("sends the product's printable endorsements to the worker, and nothing when it has none", () => {
    const base = {
      jobId: "job1",
      workspaceId: "ws1",
      tier: "growth" as const,
      channels: ["amazon"],
      mode: "listing" as const,
      creditBudget: 30,
      media: [{ r2Key: "m1", kind: "image" as const }],
    };
    const product = { id: "p1", title: "Mug", mode: "listing" as const, amazonSku: null };
    const withLines = buildGeneratePackInput({
      ...base,
      product: { ...product, endorsements: [" Loved by  hikers", "", "Loved by hikers", "z".repeat(80)] },
    });
    expect(withLines.endorsements).toEqual(["Loved by hikers"]);
    expect(buildGeneratePackInput({ ...base, product }).endorsements).toBeUndefined();
  });
});

describe("A+ modules in the estimate", () => {
  it("names each module and holds the deterministic price for each", () => {
    const channels = ["amazon.aplus.basic_header"];
    const without = estimatePackCredits(channels, "listing", "growth");
    const labels = without.lines.map((line) => line.label);
    for (const name of [
      "A plus features module",
      "A plus problems solved module",
      "A plus how to use module",
      "A plus materials module",
      "A plus results module",
    ]) {
      expect(labels.some((label) => label.startsWith(name)), name).toBe(true);
    }
    expect(labels.some((label) => label.startsWith("A plus press quotes and awards module"))).toBe(false);
    for (const label of labels) {
      expect(rule9Problems(label), label).toEqual([]);
    }
    const withEndorsements = estimatePackCredits(channels, "listing", "growth", { hasEndorsements: true });
    expect(withEndorsements.lines.some((line) => line.label.startsWith("A plus press quotes and awards module"))).toBe(true);
    // One more module fills the page, so the second hero banner makes way:
    // the page never holds more than seven A+ images.
    expect(withEndorsements.total - without.total).toBe(0);
    expect(creditCosts.deterministic).toBe(0.5);
  });
});

describe("the endorsement module's name", () => {
  it("never says reviews, which Amazon does not allow in A+ content", () => {
    const estimate = estimatePackCredits(["amazon.aplus.basic_header"], "listing", "growth", { hasEndorsements: true });
    const line = estimate.lines.find((l) => l.label.includes("press quotes"));
    expect(line).toBeDefined();
    for (const label of [line!.label, shotTypeLabel("aplus_endorsement")]) {
      expect(label, label).not.toMatch(/review/i);
      expect(rule9Problems(label), label).toEqual([]);
    }
  });
});

describe("A+ module board copy", () => {
  it("asks for a press quote or award when the seller gave none", () => {
    expect(skippedCopy(NO_ENDORSEMENT_REASON, "aplus_endorsement")).toEqual(NO_ENDORSEMENT_COPY);
    expect(NO_ENDORSEMENT_COPY.note.startsWith("Add a press quote or award to include this module.")).toBe(true);
  });

  it("gives every module reason its own plain line, with no charge", () => {
    const reasons = [
      NO_ENDORSEMENT_REASON,
      APLUS_CLAIMS_FLAG_REASON,
      APLUS_NO_FACTS_REASON,
      APLUS_COPY_SHORT_REASON,
      APLUS_MODULE_CAP_REASON,
    ];
    const notes = reasons.map((reason) => skippedCopy(reason, "aplus_results").note);
    expect(new Set(notes).size).toBe(reasons.length);
    for (const note of notes) {
      expect(note).toMatch(/charged/);
      expect(note).not.toBe(skippedCopy("something new").note);
      expect(rule9Problems(note), note).toEqual([]);
    }
  });
});
