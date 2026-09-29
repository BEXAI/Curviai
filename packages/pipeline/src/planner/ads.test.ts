/**
 * PHASE_16 workstream 3: planning the moodboard pin, the carousel and the
 * ad pack. The ads family is off by default and then changes nothing; on,
 * the formats follow the seed, the registry text limits and founder
 * decision 4 (one scene layer per carousel, never one per slide).
 */
import { describe, expect, it } from "vitest";
import { adTextLimit, getSpec } from "@curvi/specs";
import {
  DEFAULT_OUTPUT_OPTIONS,
  normalizeOutputOptions,
  planFlagsOf,
  resolveOutputOptions,
  type OutputOptionsInput,
} from "../output-options";
import type { ProductProfile, Shot } from "../schemas";
import { creditCosts } from "../seed/credits";
import { adsFormats } from "../seed/templates";
import { carouselGeometry, carouselPlacementsValid } from "../templates/ads-layout";
import {
  ADS_NO_COPY_REASON,
  CAROUSEL_INCOMPLETE_REASON,
  adHeadlines,
  adPackPlan,
  carouselStory,
  dropIncompleteCarousels,
} from "./ads";
import { planShots, type PlanOptions } from "./deterministic";

function profile(overrides: Partial<ProductProfile> = {}): ProductProfile {
  return {
    productCount: 1,
    category: "home_kitchen",
    amazonProductTypeGuess: "KITCHEN",
    shopifyTaxonomyGuess: "Home & Garden > Kitchen",
    name: "Ceramic pour over mug",
    formFactor: "mug",
    materials: ["ceramic"],
    dominantColors: [{ name: "cream", hex: "#F2E8D8", coveragePct: 70 }],
    dimensions: { value: "10 x 10 x 12 cm", source: "user" },
    preserveText: [],
    preserveLogos: [],
    surface: { reflective: false, transparent: false, textured: false },
    features: ["pour over rim", "matte glaze"],
    benefits: ["keeps coffee hot", "easy grip handle", "fits any dripper", "keeps heat 2 hours"],
    targetBuyer: "home coffee drinkers",
    useContexts: ["morning kitchen counter", "office desk"],
    photographedAngles: ["front", "45", "back"],
    missingAnglesNeeded: [],
    complianceFlags: ["none"],
    imageQuality: { usableForMain: true, issues: [] },
    ...overrides,
  };
}

const AD_CHANNELS = ["meta", "pinterest", "tiktok"];

function flags(input: OutputOptionsInput = {}) {
  const normalized = normalizeOutputOptions(input);
  const resolved = resolveOutputOptions(normalized, { colorHex: "#FFFFFF", brandSweepHex: "#3A4556", keepMediaIds: [] });
  return planFlagsOf(resolved, [{ id: "m_front", angle: "front", width: 3000, height: 3000 }]);
}

function plan(output: ReturnType<typeof flags> | undefined, extra: Partial<PlanOptions> = {}, p = profile()) {
  return planShots(p, {
    channels: AD_CHANNELS,
    tier: "growth",
    creditBudget: 200,
    primaryMediaId: "m_front",
    mediaIdsByAngle: { front: "m_front" },
    ...(output ? { output } : {}),
    ...extra,
  });
}

const ADS_TYPES = new Set(["pin_moodboard", "carousel_slide", "ad_variant"]);
const adsShots = (shots: readonly Shot[]) => shots.filter((s) => ADS_TYPES.has(s.type));

describe("ads family off (the default)", () => {
  it("plans no ads format and records none as left out, exactly as before the family existed", () => {
    expect(DEFAULT_OUTPUT_OPTIONS.extras).not.toHaveProperty("ads");
    for (const output of [undefined, flags(), flags({ extras: { ads: false } })]) {
      const list = plan(output);
      expect(adsShots(list.shots)).toEqual([]);
      expect(list.skipped.filter((s) => ADS_TYPES.has(s.type.split(":")[0]!))).toEqual([]);
    }
    expect(plan(flags({ extras: { ads: false } }))).toEqual(plan(flags()));
  });

  it("keeps the options key of every pack from before the family", () => {
    expect(JSON.stringify(normalizeOutputOptions({ extras: { ads: false } }))).toBe(JSON.stringify(DEFAULT_OUTPUT_OPTIONS));
    expect(normalizeOutputOptions({ extras: { ads: true } }).extras.ads).toBe(true);
  });

  it("holds the ads family only in Everything: another bundle turns it off", () => {
    expect(normalizeOutputOptions({ bundle: "listing", extras: { ads: true } }).extras).not.toHaveProperty("ads");
    const list = plan(flags({ bundle: "listing", extras: { ads: true } }));
    expect(adsShots(list.shots)).toEqual([]);
  });
});

describe("ads family on", () => {
  it("plans a moodboard pin, one whole carousel and 4 to 6 ad variants", () => {
    const list = plan(flags({ extras: { ads: true, scenes: false } }));
    const pins = list.shots.filter((s) => s.type === "pin_moodboard");
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ method: "template", channels: ["pinterest.pin"], credits: creditCosts.deterministic });
    expect(pins[0]!.headline).toBe("Ceramic pour over mug");

    const slides = list.shots.filter((s) => s.type === "carousel_slide");
    expect(slides.length).toBeGreaterThanOrEqual(adsFormats.carousel.minSlides);
    expect(slides.length).toBeLessThanOrEqual(adsFormats.carousel.maxSlides);
    expect(slides.map((s) => s.slideIndex)).toEqual(slides.map((_, i) => i + 1));
    for (const slide of slides) {
      expect(slide).toMatchObject({
        method: "template",
        channels: [adsFormats.carousel.specId],
        carouselId: "c1",
        slideCount: slides.length,
        credits: creditCosts.deterministic,
      });
    }
    expect(slides.at(-1)!.cta).toBe(adsFormats.carousel.callToAction);

    const variants = list.shots.filter((s) => s.type === "ad_variant");
    expect(variants.length).toBeGreaterThanOrEqual(adsFormats.adPack.minVariants);
    expect(variants.length).toBeLessThanOrEqual(adsFormats.adPack.maxVariants);
    expect(variants.map((v) => v.variantKey)).toEqual(variants.map((_, i) => `v${i + 1}`));
    for (const variant of variants) {
      expect(variant.credits).toBe(creditCosts.deterministic);
      expect(adsFormats.adPack.callsToAction as readonly string[]).toContain(variant.cta);
      for (const specId of variant.channels) {
        const limit = adTextLimit(getSpec(specId));
        if (limit !== null) expect(variant.headline!.length).toBeLessThanOrEqual(limit);
      }
    }
    // Every picked placement gets its own set of variants.
    for (const specId of adsFormats.adPack.placements) {
      const count = variants.filter((v) => v.channels.includes(specId)).length;
      expect(count, specId).toBeGreaterThanOrEqual(adsFormats.adPack.minVariants);
    }
  });

  it("charges one scene layer per carousel with scenes on, never one per slide (founder decision 4)", () => {
    const list = plan(flags({ extras: { ads: true, scenes: true } }));
    const slides = list.shots.filter((s) => s.type === "carousel_slide");
    expect(slides.length).toBeGreaterThanOrEqual(3);
    expect(slides.every((s) => s.method === "composite_generate" && s.scene)).toBe(true);
    const carouselCredits = slides.reduce((sum, s) => sum + s.credits, 0);
    expect(carouselCredits).toBe(creditCosts.generativeStill);
    expect(slides[0]!.credits).toBe(creditCosts.generativeStill);
    expect(slides.slice(1).every((s) => s.credits === 0)).toBe(true);
    // Scenes off: every slide is a template at the deterministic price.
    const off = plan(flags({ extras: { ads: true, scenes: false } })).shots.filter((s) => s.type === "carousel_slide");
    expect(off.reduce((sum, s) => sum + s.credits, 0)).toBe(off.length * creditCosts.deterministic);
    // The pin takes its scene at the generative price.
    const pin = list.shots.find((s) => s.type === "pin_moodboard")!;
    expect(pin).toMatchObject({ method: "composite_generate", credits: creditCosts.generativeStill });
  });

  it("plans only the formats whose spec is picked", () => {
    const pinOnly = plan(flags({ extras: { ads: true } }), { channels: ["pinterest.pin"] });
    expect([...new Set(pinOnly.shots.map((s) => s.type))].filter((t) => ADS_TYPES.has(t)).sort()).toEqual([
      "ad_variant",
      "pin_moodboard",
    ]);
    const tiktok = plan(flags({ extras: { ads: true } }), { channels: ["tiktok.ad_9x16"] });
    expect(adsShots(tiktok.shots).every((s) => s.type === "ad_variant" && s.channels.join() === "tiktok.ad_9x16")).toBe(true);
    const amazon = plan(flags({ extras: { ads: true } }), { channels: ["amazon"] });
    expect(adsShots(amazon.shots)).toEqual([]);
  });

  it("never prints a figure or a claim word the seller did not type", () => {
    const lines = adHeadlines(profile({ benefits: ["keeps heat 2 hours", "clinically proven grip", "easy grip handle"] }), []);
    expect(lines).toEqual(["Ceramic pour over mug", "easy grip handle", "pour over rim", "matte glaze"]);
    expect(adHeadlines(profile({ benefits: ["keeps heat 2 hours"] }), ["Holds heat 2 hours"])).toContain("keeps heat 2 hours");
  });

  it("skips the pack when too few lines can be printed, and never pads it", () => {
    const thin = profile({ name: "", benefits: [], features: [] });
    const list = plan(flags({ extras: { ads: true } }), {}, thin);
    expect(adsShots(list.shots)).toEqual([]);
    expect(list.skipped).toContainEqual({ type: "pin_moodboard", reason: ADS_NO_COPY_REASON });
  });

  it("drops placements whose text limit fits too few headlines", () => {
    const short = ["Mug", "Hot", "Grip", "Rim"];
    const long = ["A headline that is longer than 27 chars", "Another headline over the limit!!", ...short.slice(0, 2)];
    const out = adPackPlan(long, ["meta.feed_4x5", "tiktok.ad_9x16"]);
    expect(out.short).toEqual(["meta.feed_4x5"]);
    expect(out.variants.every((v) => !v.channels.includes("meta.feed_4x5"))).toBe(true);
  });
});

describe("carousel story", () => {
  it("runs hook, benefits, details, in the box and the call to action, 3 to 10 slides, with valid seams", () => {
    const story = carouselStory({ profile: profile(), boxContents: ["Mug", "Gift box"], sellerText: ["Mug", "Gift box"] });
    expect(story.map((s) => s.beat)).toEqual(["hook", "benefit", "benefit", "benefit", "details", "in_the_box", "cta"]);
    const geometry = carouselGeometry(getSpec(adsFormats.carousel.specId), story.length);
    expect(carouselPlacementsValid(geometry, story.map((s) => s.role))).toBe(true);
    const thin = carouselStory({ profile: profile({ benefits: [], features: [] }), sellerText: [] });
    expect(thin).toEqual([]);
  });
});

describe("dropIncompleteCarousels", () => {
  it("ships a carousel whole or not at all", () => {
    const slide = (i: number): Pick<Shot, "type" | "carouselId" | "slideIndex" | "slideCount"> => ({
      type: "carousel_slide",
      carouselId: "c1",
      slideIndex: i,
      slideCount: 3,
    });
    const other = { type: "social_4x5" as const };
    const skipped: Array<{ type: string; reason: string }> = [];
    expect(dropIncompleteCarousels([slide(1), slide(2), slide(3), other], skipped)).toHaveLength(4);
    expect(dropIncompleteCarousels([slide(1), slide(3), other], skipped)).toEqual([other]);
    expect(skipped).toEqual([
      { type: "carousel_slide", reason: CAROUSEL_INCOMPLETE_REASON },
      { type: "carousel_slide", reason: CAROUSEL_INCOMPLETE_REASON },
    ]);
  });

  it("drops the whole carousel when the budget trims its scene layer", () => {
    const full = plan(flags({ extras: { ads: true, scenes: true } }));
    const total = full.shots.reduce((sum, s) => sum + s.credits, 0);
    for (let budget = 1; budget < total; budget += 1) {
      const list = plan(flags({ extras: { ads: true, scenes: true } }), { creditBudget: budget });
      const slides = list.shots.filter((s) => s.type === "carousel_slide");
      if (slides.length > 0) {
        expect(slides.length).toBe(slides[0]!.slideCount);
        expect(slides[0]!.slideIndex).toBe(1);
      }
    }
  });
});
