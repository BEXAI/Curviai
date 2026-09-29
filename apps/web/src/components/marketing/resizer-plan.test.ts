import { describe, expect, it } from "vitest";
import { canvasSizeFor, originalFitFor, specAcceptsImage } from "@curvi/pipeline/output-options";
import { stillStyle } from "@curvi/pipeline/seed";
import { getSpec, requiresWhiteBackground } from "@curvi/specs";
import {
  RESIZER_PAD_HEX,
  resizerLayout,
  resizerSizeLine,
  resizerSpecs,
  resizerTooSmallLine,
  resizerWhiteLine,
} from "./resizer-plan";
import { imageSpecs } from "./spec-slug";

// PHASE_15 P1, free resizer alignment: the free tool follows the kept photo
// rules, so it never pads a photo onto white for a channel that requires a
// removed background.

const RULE_9 = /[‒-―←-⇿➔➡]| - |->|\p{Extended_Pictographic}/u;

describe("the free resizer's channels", () => {
  it("never offers a white required channel, and says why", () => {
    const { usable, needsPack } = resizerSpecs(imageSpecs());
    expect(usable.some((spec) => requiresWhiteBackground(spec))).toBe(false);
    expect(usable.every((spec) => specAcceptsImage(spec, "original"))).toBe(true);
    expect(needsPack.map((spec) => spec.id)).toContain("amazon.main");
    expect(usable.map((spec) => spec.id)).toContain("amazon.secondary");
    expect(resizerWhiteLine("amazon.main")).toBe("Amazon main image needs the background removed. Make a pack to get one.");
  });

  it("describes each channel's size by its fit", () => {
    const story = getSpec("meta.story_9x16");
    expect(originalFitFor(story)).toBe("pad");
    const size = canvasSizeFor(story);
    expect(resizerSizeLine(story)).toBe(`${size.width} by ${size.height} px`);
    expect(resizerSizeLine(getSpec("shopify.product"))).toBe("Keeps your photo's shape");
  });
});

describe("resizerLayout", () => {
  it("keeps the photo's shape where the channel allows it", () => {
    const layout = resizerLayout(getSpec("shopify.product"), { width: 3000, height: 2000 });
    expect(layout.padded).toBe(false);
    expect(layout.canvasWidth / layout.canvasHeight).toBeCloseTo(1.5, 2);
    expect(layout).toMatchObject({ drawX: 0, drawY: 0, tooSmall: false });
  });

  it("centers the photo on the canvas of a set shape channel, inside it", () => {
    const spec = getSpec("meta.story_9x16");
    const layout = resizerLayout(spec, { width: 3000, height: 2000 });
    expect(layout.padded).toBe(true);
    expect({ width: layout.canvasWidth, height: layout.canvasHeight }).toEqual(canvasSizeFor(spec));
    expect(layout.drawWidth).toBeLessThanOrEqual(layout.canvasWidth);
    expect(layout.drawY).toBeGreaterThanOrEqual(0);
    expect(layout.drawY + layout.drawHeight).toBeLessThanOrEqual(layout.canvasHeight);
    expect(RESIZER_PAD_HEX).toBe(stillStyle.whiteHex);
  });

  it("marks a photo too small to reach a channel within the enlarge cap", () => {
    const layout = resizerLayout(getSpec("amazon.secondary"), { width: 300, height: 200 });
    expect(layout.tooSmall).toBe(true);
    expect(resizerTooSmallLine("amazon.secondary", { width: 300, height: 200 })).toContain(
      "This photo is 300 by 200 pixels, too small for Amazon secondary images without enlarging it more than 1.5 times.",
    );
  });

  it("keeps its copy plain (rule 9)", () => {
    for (const line of [
      resizerWhiteLine("walmart.main"),
      resizerSizeLine(getSpec("shopify.product")),
      resizerTooSmallLine("etsy.listing", { width: 10, height: 10 }),
    ]) {
      expect(line, line).not.toMatch(RULE_9);
    }
  });
});
