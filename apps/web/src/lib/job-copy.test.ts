import { describe, expect, it } from "vitest";
import { needsReviewNote, packSummaryLine, publicJobError, skippedCopy } from "./job-copy";

// Rule 9: plain spoken, no emojis, no arrows, no dashes as punctuation.
const FORBIDDEN = /[–—→←]| - |->|=>|[\u{1F300}-\u{1FAFF}]/u;

describe("skippedCopy", () => {
  it("names the planner reasons a seller can act on", () => {
    expect(skippedCopy("needs photo").label).toBe("Needs photo");
    expect(skippedCopy("not included in this plan tier").label).toBe("Not in your plan");
    expect(skippedCopy("Pro or Agency only").label).toBe("Not in your plan");
    expect(skippedCopy("provider not enabled").label).toBe("Coming soon");
    expect(skippedCopy("seller did not list contents").label).toBe("Needs details");
    expect(skippedCopy("dimensions not confirmed by the seller or packaging").label).toBe("Needs details");
    expect(skippedCopy("concept mode excludes marketplace channels").note).toContain("Concept");
  });

  it("falls back to a generic line for reasons it does not know", () => {
    expect(skippedCopy("something new").label).toBe("Skipped");
    expect(skippedCopy(null).note).toContain("No credits were charged");
  });
});

describe("needsReviewNote", () => {
  it("never repeats the engineering hint and always says it was not charged", () => {
    const hints = [
      "Fix failed checks: fill, background",
      "The lifestyle shot needs the image, cutout and storage providers, and at least one is not configured.",
      "Cost cap reached: pack cap",
      "No product was found in the source photo for the lifestyle shot.",
      "The job was stopped before this shot finished.",
      "",
      null,
    ];
    for (const hint of hints) {
      const note = needsReviewNote(hint);
      expect(note).toContain("No credits were charged");
      expect(note).not.toMatch(/Fix failed checks|providers|cap reached|configured/);
      expect(note).not.toMatch(FORBIDDEN);
    }
  });

  it("points at the photo when the product could not be found", () => {
    expect(needsReviewNote("No product was found in the source photo for the lifestyle shot.")).toContain("photo");
  });
});

describe("publicJobError", () => {
  it("hides provider names and raw details behind a generic line", () => {
    const text = publicJobError("All providers failed for task image.generate: fal: 502 Bad Gateway");
    expect(text).not.toMatch(/providers|fal|502/i);
    expect(text).toContain("went back to your balance");
  });

  it("keeps known cases specific", () => {
    expect(publicJobError("The run was interrupted before finishing. Reserved credits were released.")).toContain(
      "interrupted",
    );
    expect(publicJobError("The pack could not be queued.")).toContain("could not start");
    expect(publicJobError("credit reservation failed")).toContain("not enough credits");
  });

  it("returns null when there is no error", () => {
    expect(publicJobError(null)).toBeNull();
    expect(publicJobError("  ")).toBeNull();
  });
});

describe("packSummaryLine", () => {
  it("summarizes a done pack in plain words", () => {
    const line = packSummaryLine({ delivered: 14, needsReview: 2, skipped: 1, creditsCharged: 23 });
    expect(line).toBe(
      "14 shots delivered. 2 need review, no charge for those. 1 shot was left out of the plan. 23 credits charged.",
    );
    expect(line).not.toMatch(FORBIDDEN);
  });

  it("handles singulars and half credits", () => {
    expect(packSummaryLine({ delivered: 1, needsReview: 1, skipped: 0, creditsCharged: 0.5 })).toBe(
      "1 shot delivered. 1 needs review, no charge for that one. 0.5 credits charged.",
    );
  });
});
