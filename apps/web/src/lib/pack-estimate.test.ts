import { describe, expect, it } from "vitest";
import { normalizeOutputOptions, type OutputOptionsInput, type OutputPlanFlags } from "@curvi/pipeline/output-options";
import {
  backgroundSwatches,
  creditCosts,
  isShotMethodDeliverable,
  undeliverableShotMethods,
  type TierKey,
} from "@curvi/pipeline/seed";
import { isSpecSelected } from "@curvi/specs";
import { deterministicPlan } from "@curvi/trigger/runner";
import {
  ESTIMATE_REFERENCE_PRODUCT,
  estimatePackCredits,
  referencePackShots,
  referencePhotoId,
  type EstimateSellerInputs,
} from "./pack-estimate";

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
      "Lifestyle scenes, 3",
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

describe("estimatePackCredits follows the output options (PHASE_15 pricing fixtures)", () => {
  /** The flags the form sends before it knows any media id. */
  function output(input: OutputOptionsInput): OutputPlanFlags {
    const normalized = normalizeOutputOptions(input);
    return {
      background: normalized.background,
      keepMediaIds: [],
      extras: normalized.extras,
      fit: normalized.fit,
      photos: [],
      sceneCount: normalized.sceneCount,
    };
  }
  const threePhotos = [{}, {}, {}];
  const sum = (lines: ReadonlyArray<{ credits: number }>) => lines.reduce((total, line) => total + line.credits, 0);
  const estimate = (channels: string[], input?: OutputOptionsInput, extra: Partial<EstimateSellerInputs> = {}) =>
    estimatePackCredits(channels, "listing", STILLS_ONLY, {
      ...(input ? { output: output(input) } : {}),
      photos: threePhotos,
      ...extra,
    });
  const shotCount = (channels: string[], input?: OutputOptionsInput) =>
    referencePackShots(channels, "listing", STILLS_ONLY, undefined, {
      ...(input ? { output: output(input) } : {}),
      photos: threePhotos,
    }).length;

  // The price is creditCosts.deterministic (0.5) per the founder decision.
  it("uses the price the fixtures assume", () => {
    expect(creditCosts.deterministic).toBe(0.5);
  });

  const KEEP_WIDE = ["amazon.main", "walmart.main", "tiktokshop.main", "google.merchant.main", "etsy.listing", "ebay.listing"];
  const fixtures: Array<{ name: string; channels: string[]; input?: OutputOptionsInput; shots: number; charged: number; hold: number }> = [
    // Founder decision 4: a default pack plans 3 scenes, one more than before.
    { name: "Marketplace ready (today)", channels: DEFAULT_FORM, shots: 12, charged: 7.5, hold: 8 },
    { name: "Marketplace ready, 1 scene", channels: DEFAULT_FORM, input: { sceneCount: 1 }, shots: 10, charged: 5.5, hold: 6 },
    { name: "Marketplace ready, 4 scenes", channels: DEFAULT_FORM, input: { sceneCount: 4 }, shots: 13, charged: 8.5, hold: 9 },
    { name: "Marketplace ready, scenes off", channels: DEFAULT_FORM, input: { extras: { scenes: false } }, shots: 9, charged: 4.5, hold: 5 },
    { name: "Keep my photo (Amazon main made white)", channels: DEFAULT_FORM, input: { background: "keep" }, shots: 4, charged: 2, hold: 2 },
    {
      name: "Keep my photo, Amazon main left out",
      channels: DEFAULT_FORM.filter((c) => c !== "amazon.main"),
      input: { background: "keep" },
      shots: 3,
      charged: 1.5,
      hold: 2,
    },
    { name: "Keep my photo plus 3 scenes", channels: DEFAULT_FORM, input: { background: "keep", extras: { scenes: true } }, shots: 7, charged: 5, hold: 5 },
    { name: "Keep my photo for six marketplaces", channels: KEEP_WIDE, input: { background: "keep" }, shots: 6, charged: 3, hold: 3 },
  ];
  for (const fixture of fixtures) {
    it(`prices ${fixture.name}`, () => {
      const result = estimate(fixture.channels, fixture.input);
      expect(shotCount(fixture.channels, fixture.input)).toBe(fixture.shots);
      expect(sum(result.lines)).toBe(fixture.charged);
      expect(result.total).toBe(fixture.hold);
    });
  }

  it("prices today's pack the same with no options, the default options or three photos", () => {
    const today = estimatePackCredits(DEFAULT_FORM, "listing", STILLS_ONLY);
    expect(estimate(DEFAULT_FORM, {})).toEqual(today);
    expect(estimatePackCredits(DEFAULT_FORM, "listing", STILLS_ONLY, { output: output({}) })).toEqual(today);
  });

  it("labels the kept photos and the made white files", () => {
    expect(estimate(DEFAULT_FORM, { background: "keep" }).lines).toEqual([
      { label: "Made white for channels that require it", credits: creditCosts.deterministic },
      { label: "Your photos, resized for each channel, 3", credits: 3 * creditCosts.deterministic },
    ]);
    const one = estimate(["etsy.listing"], { background: "keep" }, { photos: [{ angle: "front" }] });
    expect(one.lines).toEqual([{ label: "Your photo, resized for each channel", credits: creditCosts.deterministic }]);
    const wide = estimate(KEEP_WIDE, { background: "keep" }).lines.map((line) => line.label);
    expect(wide).toEqual(["Made white for channels that require it, 3", "Your photos, resized for each channel, 3"]);
  });

  it("reads other angles on your background when the color is not white", () => {
    const sand = backgroundSwatches.sand.hex;
    const labels = estimate(["etsy.listing"], {}, { colorHex: sand }).lines.map((line) => line.label);
    expect(labels).toContain("Front image on your background");
    expect(labels).toContain("Other angles on your background, 2");
    const white = estimate(["etsy.listing"], {}).lines.map((line) => line.label);
    expect(white).toContain("White front image");
    expect(white).toContain("Alternate angles on white, 2");
  });

  it("plans the real photo count, with the front photo on the primary media id", () => {
    const shots = referencePackShots(["etsy.listing"], "listing", STILLS_ONLY, "front_media", {
      output: output({ background: "keep" }),
      photos: [{ angle: "back" }, { angle: "front" }, {}, {}, {}],
    });
    expect(shots.map((shot) => shot.sourceMediaId)).toEqual([
      "reference_photo_1",
      "front_media",
      referencePhotoId(3),
      referencePhotoId(4),
      referencePhotoId(5),
    ]);
    expect(shots.find((shot) => shot.priority === 1)!.sourceMediaId).toBe("front_media");
  });

  it("holds nothing for a kept photo too small for every picked spec", () => {
    const small = estimate(["amazon.secondary"], { background: "keep" }, { photos: [{ angle: "front", width: 600, height: 600 }] });
    expect(small).toEqual({ total: 0, lines: [] });
    // Unknown sizes fit, so the form's figure is an upper bound.
    expect(estimate(["amazon.secondary"], { background: "keep" }, { photos: [{ angle: "front" }] }).total).toBe(1);
  });

  it("holds what the runner's deterministic plan makes, for random option sets", () => {
    // A small seeded generator, so a failure replays.
    let seed = 15;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
    const channelSets = [DEFAULT_FORM, KEEP_WIDE, ["amazon", "shopify", "google", "meta", "pinterest"], ["meta.feed_4x5", "etsy.listing"]];
    const sizes = [undefined, 600, 1200, 3000];
    for (let run = 0; run < 60; run++) {
      const input: OutputOptionsInput = {
        background: pick(["remove", "keep"] as const),
        fit: pick(["auto", "pad"] as const),
        extras: { scenes: random() < 0.5, backdrops: random() < 0.5, transparentPng: random() < 0.5, graphics: random() < 0.5, cards: random() < 0.5 },
      };
      const count = 1 + Math.floor(random() * 6);
      const angles = ["front", "45", "back", "top", "side", "detail"].slice(0, count);
      const photos = angles.map((angle, i) => {
        const size = pick(sizes);
        return { id: `r2/${i}`, angle, ...(size ? { width: size, height: size } : {}) };
      });
      const flags: OutputPlanFlags = {
        ...output(input),
        keepMediaIds: input.background === "keep" ? photos.map((p) => p.id) : [],
        photos,
      };
      const channels = pick(channelSets);
      const held = estimatePackCredits(channels, "listing", STILLS_ONLY, { output: flags }).total;
      const excludeMethods = [...undeliverableShotMethods];
      const plan = deterministicPlan(
        ESTIMATE_REFERENCE_PRODUCT,
        {
          channels,
          tier: STILLS_ONLY,
          creditBudget: held,
          primaryMediaId: "r2/0",
          mediaIdsByAngle: Object.fromEntries(photos.map((p) => [p.angle, p.id])),
          undeliverableMethods: excludeMethods,
          output: flags,
        },
        { channels, mode: "listing", budget: held, profile: ESTIMATE_REFERENCE_PRODUCT, primaryMediaId: "r2/0", excludeMethods },
      );
      const label = `${JSON.stringify(input)} ${count} ${channels.join(",")}`;
      expect(Math.ceil(plan.shots.reduce((total, s) => total + s.credits, 0)), label).toBe(held);
      expect(plan.skipped.some((s) => s.reason === "credit budget"), label).toBe(false);
    }
  });

  it("maps createJob's kept media to the estimate's photos by position", () => {
    const flags: OutputPlanFlags = {
      ...output({ background: "keep" }),
      keepMediaIds: ["r2/a", "r2/b"],
      photos: [
        { id: "r2/a", angle: "front", width: 3000, height: 3000 },
        { id: "r2/b", width: 3000, height: 3000 },
      ],
    };
    const lines = estimatePackCredits(["etsy.listing"], "listing", STILLS_ONLY, { output: flags }).lines;
    expect(lines).toEqual([{ label: "Your photos, resized for each channel, 2", credits: 2 * creditCosts.deterministic }]);
  });
});
