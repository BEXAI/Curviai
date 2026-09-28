import { describe, expect, it } from "vitest";
import { creditCosts, isShotMethodDeliverable, type TierKey } from "@curvi/pipeline/seed";
import { estimatePackCredits } from "./pack-estimate";

const STILLS_ONLY: TierKey = "starter";

describe("estimatePackCredits", () => {
  it("returns zero for no channels", () => {
    expect(estimatePackCredits([], "listing", "growth").total).toBe(0);
  });

  it("adds marketplace assets when amazon is selected", () => {
    const withoutAmazon = estimatePackCredits(["meta.feed_1x1"], "listing", "starter");
    const withAmazon = estimatePackCredits(["meta.feed_1x1", "amazon.main"], "listing", "starter");
    expect(withAmazon.total).toBeGreaterThan(withoutAmazon.total);
  });

  it("drops marketplace only assets in concept mode", () => {
    const listing = estimatePackCredits(["amazon.main", "shopify.product"], "listing", "starter");
    const concept = estimatePackCredits(["amazon.main", "shopify.product"], "concept", "starter");
    expect(concept.total).toBeLessThan(listing.total);
    expect(concept.lines.some((l) => l.label.includes("Amazon"))).toBe(false);
  });

  it("lists generative video only from growth up", () => {
    const starter = estimatePackCredits(["amazon.main"], "listing", "starter");
    const growth = estimatePackCredits(["amazon.main"], "listing", "growth");
    expect(starter.lines.some((l) => l.label.includes("Hero loop"))).toBe(false);
    expect(growth.lines.some((l) => l.label.includes("Hero loop"))).toBe(true);
  });

  it("lists the UGC hook ad only on pro and agency", () => {
    const growth = estimatePackCredits(["amazon.main"], "listing", "growth");
    const pro = estimatePackCredits(["amazon.main"], "listing", "pro");
    expect(growth.lines.some((l) => l.label.includes("UGC"))).toBe(false);
    expect(pro.lines.some((l) => l.label.includes("UGC"))).toBe(true);
  });
});

describe("estimatePackCredits holds nothing for output production cannot deliver", () => {
  it("prices video at 0 credits and labels it coming soon while video is not delivered", () => {
    expect(isShotMethodDeliverable("video_generate")).toBe(false);
    expect(isShotMethodDeliverable("avatar")).toBe(false);
    const pro = estimatePackCredits(["amazon.main"], "listing", "pro");
    const video = pro.lines.filter((l) => /Hero loop|Lifestyle clip|UGC/.test(l.label));
    expect(video).toHaveLength(3);
    for (const line of video) {
      expect(line.credits).toBe(0);
      expect(line.comingSoon).toBe(true);
      expect(line.label).toMatch(/, coming soon$/);
    }
  });

  it("gives every tier the same stills total, so a Pro pack holds what it ships", () => {
    for (const channels of [["amazon.main"], ["amazon.main", "shopify.product", "meta.feed_1x1"], ["meta.feed_1x1"]]) {
      const stills = estimatePackCredits(channels, "listing", STILLS_ONLY).total;
      for (const tier of ["free", "growth", "pro", "agency"] as TierKey[]) {
        expect(estimatePackCredits(channels, "listing", tier).total, `${tier} ${channels.join(",")}`).toBe(stills);
      }
    }
  });

  it("lets a Pro workspace with 20 credits afford a full stills pack", () => {
    const pro = estimatePackCredits(["amazon.main", "shopify.product", "meta.feed_1x1"], "listing", "pro");
    expect(pro.total).toBeLessThanOrEqual(20);
    // Before this fix the same pack held 6 + 15 + 30 more credits of video.
    const heldVideoBefore = 6 * creditCosts.generativeVideoPerSecondLite + 15 * creditCosts.generativeVideoPerSecondLite + creditCosts.ugcAvatarAd;
    expect(pro.total + heldVideoBefore).toBeGreaterThan(20);
  });
});
