import { describe, expect, it } from "vitest";
import { SIZED_FOR_EACH_CHANNEL_TITLE } from "@/lib/output-options-copy";
import { TITLE_MAX } from "@/lib/seo";
import { shareDescription, shareIntro, shareOgAlt, sharePackHeading, shareTitle } from "./page-copy";

const before = { ref: "before", src: "/s/abc/image/before", alt: "Kettle, the original photo" };
const makeover = { title: "Copper kettle", before, sizedForChannels: false };
const resultOnly = { title: "Copper kettle", before: null, sizedForChannels: false };
const kept = { title: "Copper kettle", before: null, sizedForChannels: true };

describe("share page copy", () => {
  it("offers a before and after only for a makeover with its before photo", () => {
    expect(shareTitle(makeover)).toBe("Copper kettle, before and after");
    expect(shareDescription(makeover)).toContain("Drag the slider");
    expect(shareOgAlt(makeover)).toContain("before and after");
    expect(shareIntro(makeover)).toContain("Drag the divider");
    expect(sharePackHeading(makeover)).toBe("The whole pack");

    expect(shareDescription(resultOnly)).not.toContain("slider");
    expect(shareOgAlt(resultOnly)).not.toContain("before and after");
    expect(shareIntro(resultOnly)).not.toContain("Drag");
  });

  it("never claims a makeover or a slider when the hero is a kept photo", () => {
    for (const text of [shareTitle(kept), shareDescription(kept), shareOgAlt(kept), shareIntro(kept)]) {
      expect(text).not.toMatch(/before and after|slider|divider|studio pack/i);
    }
    expect(shareTitle(kept)).toBe("Copper kettle, sized for each channel");
    expect(sharePackHeading(kept)).toBe(SIZED_FOR_EACH_CHANNEL_TITLE);
  });

  it("falls back to a generic title that fits beside the site name", () => {
    const long = "A".repeat(TITLE_MAX);
    for (const share of [{ ...makeover, title: long }, { ...kept, title: long }]) {
      const title = shareTitle(share);
      expect(title.length).toBeLessThanOrEqual(TITLE_MAX - 8);
      expect(title).not.toContain(long);
    }
    expect(shareTitle({ ...kept, title: long })).toContain("sized for each channel");
  });

  it("follows the copy rules: no emoji, arrows or dash punctuation", () => {
    for (const share of [makeover, resultOnly, kept]) {
      const texts = [shareTitle(share), shareDescription(share), shareOgAlt(share), shareIntro(share), sharePackHeading(share)];
      for (const text of texts) {
        expect(text).not.toMatch(/[–—←-⇿]| - |\p{Extended_Pictographic}/u);
      }
    }
  });
});
