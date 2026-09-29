import { describe, expect, it, vi } from "vitest";
import { getSpec, type ChannelSpec } from "@curvi/specs";

// CLAUDE.md rule 2 (docs/phases/PHASE_15.md Tests): the figures in the
// output options copy come from their sources, so changing the enlarge
// limit or a registry background rule changes the rendered copy.
vi.mock("@curvi/pipeline/output-options", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@curvi/pipeline/output-options")>()),
  MAX_SOURCE_UPSCALE: 2.25,
}));

const { needsReviewNote, skippedCopy } = await import("./job-copy");
const { conflictCopy, tooSmallLine, whiteChannelsLine, whiteRequiredSpecIds } = await import("./output-options-copy");
const { SOURCE_TOO_SMALL_REASON } = await import("@curvi/pipeline/output-options");

function spec(id: string, background: ChannelSpec["background"]): ChannelSpec {
  return { ...getSpec("etsy.listing"), id, background };
}

describe("rule 2 copy", () => {
  it("reads the enlarge limit from MAX_SOURCE_UPSCALE", () => {
    expect(skippedCopy(SOURCE_TOO_SMALL_REASON).note).toContain("more than 2.25 times");
    expect(needsReviewNote(SOURCE_TOO_SMALL_REASON)).toContain("more than 2.25 times");
    expect(tooSmallLine("amazon.secondary", { width: 900, height: 675 })).toContain("more than 2.25 times");
    expect(
      conflictCopy({ code: "too_small", specId: "etsy.listing", photoId: "p" }, { background: "keep" }).text,
    ).toContain("more than 2.25 times");
  });

  it("reads which channels stay white from the registry rule", () => {
    const white = [spec("amazon.main", { type: "solid", rgb: [255, 255, 255] }), spec("newshop.main", { type: "white_preferred" })];
    expect(whiteRequiredSpecIds(["amazon.main", "newshop.main"], white)).toEqual(["amazon.main", "newshop.main"]);
    expect(whiteChannelsLine(["amazon.main", "newshop.main"], white)).toBe(
      "Amazon main image and Newshop main stay pure white. Your color is used everywhere else.",
    );
    // The same spec with its rule relaxed no longer stays white.
    const relaxed = [white[0], spec("newshop.main", { type: "any" })];
    expect(whiteChannelsLine(["amazon.main", "newshop.main"], relaxed)).toBe(
      "Amazon main image stays pure white. Your color is used everywhere else.",
    );
    const gray = [spec("amazon.main", { type: "solid", rgb: [240, 240, 240] })];
    expect(whiteChannelsLine(["amazon.main"], gray)).toBeNull();
  });
});
