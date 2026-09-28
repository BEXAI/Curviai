import { describe, expect, it } from "vitest";
import {
  creditCosts,
  isShotMethodDeliverable,
  undeliverableShotMethods,
  type TierKey,
} from "@curvi/pipeline/seed";
import { isSpecSelected } from "@curvi/specs";
import { deterministicPlan } from "@curvi/trigger/runner";
import { ESTIMATE_REFERENCE_PRODUCT, estimatePackCredits, referencePackShots } from "./pack-estimate";

const STILLS_ONLY: TierKey = "starter";
/** The new pack form's preselected channels. */
const DEFAULT_FORM = ["amazon.main", "amazon.secondary", "shopify.product", "meta.feed_1x1"];
const labels = (channels: string[], tier: TierKey = STILLS_ONLY): string[] =>
  estimatePackCredits(channels, "listing", tier).lines.map((l) => l.label);

describe("estimatePackCredits", () => {
  it("returns zero for no channels", () => {
    expect(estimatePackCredits([], "listing", "growth")).toEqual({ total: 0, lines: [] });
  });

  it("adds the Amazon main image only when amazon.main is picked", () => {
    const withoutAmazon = estimatePackCredits(["meta.feed_1x1"], "listing", "starter");
    const withAmazon = estimatePackCredits(["meta.feed_1x1", "amazon.main"], "listing", "starter");
    const sum = (lines: Array<{ credits: number }>) => lines.reduce((total, line) => total + line.credits, 0);
    expect(sum(withAmazon.lines)).toBeGreaterThan(sum(withoutAmazon.lines));
    expect(withAmazon.lines).toContainEqual({ label: "Amazon main image", credits: creditCosts.deterministic });
    expect(withoutAmazon.lines.some((l) => l.label.includes("Amazon"))).toBe(false);
  });

  it("drops marketplace only assets in concept mode", () => {
    const listing = estimatePackCredits(["amazon.main", "shopify.product", "meta.feed_1x1"], "listing", "starter");
    const concept = estimatePackCredits(["amazon.main", "shopify.product", "meta.feed_1x1"], "concept", "starter");
    expect(concept.total).toBeLessThan(listing.total);
    expect(concept.lines).toEqual([{ label: "Social crop", credits: creditCosts.deterministic }]);
    expect(estimatePackCredits(["amazon.main", "shopify.product"], "concept", "starter").total).toBe(0);
  });

  it("lists generative video only from growth up, when a video channel is picked", () => {
    const channels = ["amazon.main", "video.social_9x16"];
    expect(labels(channels, "starter").some((l) => l.includes("Hero loop"))).toBe(false);
    expect(labels(channels, "growth").some((l) => l.includes("Hero loop"))).toBe(true);
    // Without a video channel no video is planned, on any plan.
    expect(labels(["amazon.main"], "agency").some((l) => /Hero loop|clip|UGC/.test(l))).toBe(false);
  });

  it("lists the UGC hook ad only on pro and agency", () => {
    const channels = ["amazon.main", "video.social_9x16"];
    expect(labels(channels, "growth").some((l) => l.includes("UGC"))).toBe(false);
    expect(labels(channels, "pro").some((l) => l.includes("UGC"))).toBe(true);
  });
});

describe("estimatePackCredits lists and holds only what the pack makes (Update.md 2.11)", () => {
  it("holds no A plus banner, Shopify hero, 4:5 crop or story for the default form", () => {
    const estimate = estimatePackCredits(DEFAULT_FORM, "listing", STILLS_ONLY);
    const names = estimate.lines.map((l) => l.label);
    expect(names).toEqual([
      "Amazon main image",
      "Alternate angles on white, 2",
      "Transparent cutout",
      "Background sweeps, 2",
      "Lifestyle scenes, 2",
      "Infographic",
      "Collection thumbnail",
      "Social crop",
    ]);
    for (const unpicked of ["A plus", "Shopify hero", "Social crops"]) {
      expect(names.some((l) => l.includes(unpicked)), unpicked).toBe(false);
    }
  });

  it("lists A plus banners, the Shopify hero and every crop only when their specs are picked", () => {
    const names = labels(["amazon", "shopify", "meta"]);
    expect(names).toEqual(expect.arrayContaining(["A plus banners, 2", "Shopify hero", "Social crops, 3"]));
    expect(labels(["amazon.main", "amazon.aplus.basic_header"])).toContain("A plus banners, 2");
    expect(labels(["shopify.hero_banner"])).toEqual(["Shopify hero"]);
  });

  it("prices single channel picks at what they make", () => {
    expect(estimatePackCredits(["meta.feed_1x1"], "listing", STILLS_ONLY)).toEqual({
      total: 1,
      lines: [{ label: "Social crop", credits: creditCosts.deterministic }],
    });
    expect(estimatePackCredits(["pinterest.pin"], "listing", STILLS_ONLY)).toEqual({
      total: 1,
      lines: [{ label: "Pinterest pin", credits: creditCosts.deterministic }],
    });
    expect(labels(["google.merchant.main"])).toEqual(["White front image"]);
    // Etsy takes no generated scene, so an Etsy pick holds none.
    const etsy = labels(["etsy.listing"]);
    expect(etsy[0]).toBe("White front image");
    expect(etsy.some((l) => l.startsWith("Lifestyle"))).toBe(false);
  });

  it("holds exactly what the worker's deterministic plan makes for the reference product", () => {
    const selections = [
      DEFAULT_FORM,
      ["amazon.main", "etsy.listing"],
      ["etsy.listing", "google"],
      ["amazon.main", "walmart.main", "tiktokshop.main"],
      ["pinterest.pin", "ebay.listing"],
      ["meta.feed_1x1"],
      ["amazon", "shopify", "google", "meta", "pinterest"],
      ["shopify.hero_banner", "meta.story_9x16"],
    ];
    for (const tier of ["free", "starter", "growth", "pro", "agency"] as TierKey[]) {
      for (const channels of selections) {
        const excludeMethods = [...undeliverableShotMethods];
        const budget = Number.MAX_SAFE_INTEGER;
        const plan = deterministicPlan(
          ESTIMATE_REFERENCE_PRODUCT,
          { channels, tier, creditBudget: budget, primaryMediaId: "m1", undeliverableMethods: excludeMethods },
          { channels, mode: "listing", budget, profile: ESTIMATE_REFERENCE_PRODUCT, primaryMediaId: "m1", excludeMethods },
        );
        const runs = Math.ceil(plan.shots.reduce((sum, s) => sum + s.credits, 0));
        const estimate = estimatePackCredits(channels, "listing", tier);
        expect(estimate.total, `${tier} ${channels.join(",")}`).toBe(runs);
        // Every counted shot ships to a picked spec.
        for (const shot of referencePackShots(channels, "listing", tier)) {
          expect(shot.channels.every((c) => isSpecSelected(channels, c)), `${shot.type} ${shot.channels.join()}`).toBe(
            true,
          );
        }
      }
    }
  });
});

describe("estimatePackCredits holds nothing for output production cannot deliver", () => {
  it("prices video at 0 credits and labels it coming soon while video is not delivered", () => {
    expect(isShotMethodDeliverable("video_generate")).toBe(false);
    expect(isShotMethodDeliverable("avatar")).toBe(false);
    const pro = estimatePackCredits(["amazon.main", "video.social_9x16"], "listing", "pro");
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
        expect(
          estimatePackCredits([...channels, "video.social_9x16"], "listing", tier).total,
          `${tier} ${channels.join(",")} with video`,
        ).toBe(stills);
      }
    }
  });

  it("lets a Pro workspace with 20 credits afford a full stills pack", () => {
    const pro = estimatePackCredits(["amazon.main", "shopify.product", "meta.feed_1x1"], "listing", "pro");
    expect(pro.total).toBeLessThanOrEqual(20);
    // Before video was held at 0 the same pack held 6 + 15 + 30 more credits.
    const heldVideoBefore = 6 * creditCosts.generativeVideoPerSecondLite + 15 * creditCosts.generativeVideoPerSecondLite + creditCosts.ugcAvatarAd;
    expect(pro.total + heldVideoBefore).toBeGreaterThan(20);
  });
});
