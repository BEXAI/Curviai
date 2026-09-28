import { describe, expect, it } from "vitest";
import { channelFileLimit, dimensionBounds, getSpec, listSpecs } from "@curvi/specs";
import { undeliverableShotMethods } from "../seed/credits";
import { ShotList, type ProductProfile, type Shot } from "../schemas";
import {
  CHANNEL_LIMIT_REASON,
  CHANNEL_NOT_SELECTED_REASON,
  NO_COMPATIBLE_CHANNEL_REASON,
  RESERVED_GALLERY_SLOTS,
  UNDELIVERABLE_METHOD_REASON,
  capShotsPerChannel,
  channelLimitViolations,
  planShots,
  specAcceptsImage,
} from "./deterministic";

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
    preserveText: [{ text: "CURVI", location: "front" }],
    preserveLogos: [],
    surface: { reflective: false, transparent: false, textured: false },
    features: ["pour over rim"],
    benefits: ["keeps coffee hot", "easy grip handle", "fits any dripper", "dishwasher safe"],
    targetBuyer: "home coffee drinkers",
    useContexts: ["morning kitchen counter", "office desk"],
    photographedAngles: ["front", "45", "back", "top"],
    missingAnglesNeeded: ["side"],
    complianceFlags: ["none"],
    imageQuality: { usableForMain: true, issues: [] },
    ...overrides,
  };
}

const baseOpts = {
  channels: ["amazon", "shopify", "meta"],
  tier: "growth" as const,
  creditBudget: 100,
  hasBoxContents: false,
  hasComparisonFacts: false,
};

describe("planShots", () => {
  it("produces a ShotList that validates against the schema", () => {
    const list = planShots(profile(), baseOpts);
    expect(() => ShotList.parse(list)).not.toThrow();
    expect(list.shots.length).toBeGreaterThan(5);
  });

  it("always includes a deterministic amazon_main when amazon is selected", () => {
    const list = planShots(profile(), baseOpts);
    const main = list.shots.find((s) => s.type === "amazon_main");
    expect(main).toBeDefined();
    expect(main!.method).toBe("deterministic");
    expect(main!.channels).toContain("amazon.main");
  });

  it("skips amazon_main with needs photo when no front photo exists", () => {
    const list = planShots(
      profile({ photographedAngles: ["45", "side"], imageQuality: { usableForMain: false, issues: ["blur"] } }),
      baseOpts,
    );
    expect(list.shots.find((s) => s.type === "amazon_main")).toBeUndefined();
    expect(list.skipped).toContainEqual({ type: "amazon_main", reason: "needs photo" });
  });

  it("never plans unphotographed angles and records them as needs photo", () => {
    const list = planShots(profile(), baseOpts);
    const altAngles = list.shots.filter((s) => s.type === "alt_angle_white");
    // front is the main, so 45, back and top remain.
    expect(altAngles).toHaveLength(3);
    expect(list.skipped).toContainEqual({ type: "alt_angle_white:side", reason: "needs photo" });
  });

  it("stays within the credit budget by dropping lowest priority shots first", () => {
    const generous = planShots(profile(), { ...baseOpts, creditBudget: 100 });
    const tight = planShots(profile(), { ...baseOpts, creditBudget: 8 });
    const total = (l: ShotList): number => l.shots.reduce((s, x) => s + x.credits, 0);
    expect(total(generous)).toBeLessThanOrEqual(100);
    expect(total(tight)).toBeLessThanOrEqual(8);
    // The main image survives the squeeze.
    expect(tight.shots.find((s) => s.type === "amazon_main")).toBeDefined();
    // Something was dropped for budget and recorded.
    expect(tight.skipped.some((s) => s.reason === "credit budget")).toBe(true);
    // Dropped shots are the low priority ones: everything kept has priority
    // no worse than anything dropped for budget.
    const maxKept = Math.max(...tight.shots.map((s) => s.priority));
    const generousByType = new Map(generous.shots.map((s) => [s.id, s]));
    for (const skip of tight.skipped.filter((s) => s.reason === "credit budget")) {
      const match = [...generousByType.values()].find((s) => s.type === skip.type);
      if (match) {
        expect(match.priority).toBeGreaterThanOrEqual(maxKept);
      }
    }
  });

  it("plans dimensions only when dimensions exist", () => {
    const withDims = planShots(profile(), baseOpts);
    expect(withDims.shots.some((s) => s.type === "dimensions")).toBe(true);
    const noDims = planShots(profile({ dimensions: null }), baseOpts);
    expect(noDims.shots.some((s) => s.type === "dimensions")).toBe(false);
    expect(noDims.skipped.some((s) => s.type === "dimensions")).toBe(true);
    // A model guess is never printed on a charged image.
    const guessed = planShots(profile({ dimensions: { value: "about 10 cm", source: "unknown" } }), baseOpts);
    expect(guessed.shots.some((s) => s.type === "dimensions")).toBe(false);
    expect(guessed.skipped.find((s) => s.type === "dimensions")?.reason).toContain("not confirmed");
    // The full label rides on the shot for the template to lay out.
    const label = withDims.shots.find((s) => s.type === "dimensions")?.callouts;
    expect(label).toEqual(["10 x 10 x 12 cm"]);
  });

  it("plans in_the_box and comparison only when the seller supplied facts", () => {
    const bare = planShots(profile(), baseOpts);
    expect(bare.shots.some((s) => s.type === "in_the_box")).toBe(false);
    expect(bare.shots.some((s) => s.type === "comparison")).toBe(false);
    const rich = planShots(profile(), { ...baseOpts, hasBoxContents: true, hasComparisonFacts: true });
    expect(rich.shots.some((s) => s.type === "in_the_box")).toBe(true);
    expect(rich.shots.some((s) => s.type === "comparison")).toBe(true);
  });

  it("plans video_spin only with 4 or more angles or a video source", () => {
    const spin = planShots(profile(), baseOpts);
    expect(spin.shots.some((s) => s.type === "video_spin")).toBe(true);
    const few = planShots(profile({ photographedAngles: ["front", "45"] }), baseOpts);
    expect(few.shots.some((s) => s.type === "video_spin")).toBe(false);
    const withVideo = planShots(profile({ photographedAngles: ["front", "45"] }), {
      ...baseOpts,
      hasVideoSource: true,
    });
    expect(withVideo.shots.some((s) => s.type === "video_spin")).toBe(true);
  });

  it("gates video_lifestyle_15s and video_ugc_hook to Pro and Agency", () => {
    const growth = planShots(profile(), baseOpts);
    expect(growth.shots.some((s) => s.type === "video_ugc_hook")).toBe(false);
    expect(growth.skipped.some((s) => s.type === "video_ugc_hook")).toBe(true);
    const pro = planShots(profile(), { ...baseOpts, tier: "pro", creditBudget: 200 });
    expect(pro.shots.some((s) => s.type === "video_ugc_hook")).toBe(true);
    expect(pro.shots.some((s) => s.type === "video_lifestyle_15s")).toBe(true);
  });

  it("gates generative video_hero_6s below Growth", () => {
    const starter = planShots(profile(), { ...baseOpts, tier: "starter" });
    expect(starter.shots.some((s) => s.type === "video_hero_6s")).toBe(false);
    expect(starter.skipped.some((s) => s.type === "video_hero_6s")).toBe(true);
  });

  it("marks the footwear main as a single shoe angled left", () => {
    const list = planShots(profile({ category: "footwear" }), baseOpts);
    const main = list.shots.find((s) => s.type === "amazon_main");
    expect(main?.scene).toBe("single shoe angled left");
  });

  it("uses soft even light presets for reflective products", () => {
    const list = planShots(
      profile({ category: "beauty", surface: { reflective: true, transparent: false, textured: false } }),
      baseOpts,
    );
    const lifestyle = list.shots.filter((s) => s.type === "lifestyle");
    expect(lifestyle.length).toBeGreaterThan(0);
    for (const shot of lifestyle) {
      expect(shot.stylePreset).toBe("minimal_studio");
    }
  });

  it("plans 2 to 4 lifestyle scenes", () => {
    const none = planShots(profile({ useContexts: [] }), baseOpts);
    const count = none.shots.filter((s) => s.type === "lifestyle").length;
    expect(count).toBeGreaterThanOrEqual(2);
    expect(count).toBeLessThanOrEqual(4);
    const many = planShots(
      profile({ useContexts: ["a", "b", "c", "d", "e", "f"] }),
      baseOpts,
    );
    expect(many.shots.filter((s) => s.type === "lifestyle").length).toBeLessThanOrEqual(4);
  });
});

const lifestyleScenes = (list: ShotList): string[] =>
  list.shots.filter((s) => s.type === "lifestyle").map((s) => s.scene ?? "");

describe("planShots lifestyle scenes by category (Update.md 2.16)", () => {
  const GHOST = "ghost style from supplied photos";
  const apparel = (useContexts: string[], photographedAngles: ProductProfile["photographedAngles"] = ["front", "back"]) =>
    profile({ category: "apparel", useContexts, photographedAngles });

  it("gives apparel with no contexts 2 to 4 scenes including ghost style", () => {
    const scenes = lifestyleScenes(planShots(apparel([]), baseOpts));
    expect(scenes.length).toBeGreaterThanOrEqual(2);
    expect(scenes.length).toBeLessThanOrEqual(4);
    expect(scenes).toContain(GHOST);
  });

  it("keeps ghost style when apparel has 5 contexts", () => {
    const scenes = lifestyleScenes(planShots(apparel(["beach", "office", "gym", "park", "cafe"]), baseOpts));
    expect(scenes).toHaveLength(4);
    expect(scenes).toContain(GHOST);
    expect(scenes.filter((s) => s.startsWith("flat lay, "))).toHaveLength(3);
  });

  it("dedupes repeated apparel contexts and still meets the minimum", () => {
    const scenes = lifestyleScenes(planShots(apparel(["beach", "beach"]), baseOpts));
    expect(new Set(scenes).size).toBe(scenes.length);
    expect(scenes.length).toBeGreaterThanOrEqual(2);
    expect(scenes).toContain(GHOST);
  });

  it("uses the seller's contexts without flat lay or ghost style when on model photos exist", () => {
    const scenes = lifestyleScenes(planShots(apparel(["beach", "office"], ["front", "in_use"]), baseOpts));
    expect(scenes).toEqual(["beach", "office"]);
  });

  it("keeps the jewelry additions when there are 4 or more contexts", () => {
    const scenes = lifestyleScenes(
      planShots(profile({ category: "jewelry", useContexts: ["a", "b", "c", "d", "e"] }), baseOpts),
    );
    expect(scenes).toHaveLength(4);
    expect(scenes).toContain("detail macro");
    expect(scenes).toContain("scale on hand");
  });

  it("keeps a single category addition next to 4 contexts", () => {
    const scenes = lifestyleScenes(
      planShots(profile({ category: "furniture", useContexts: ["a", "b", "c", "d"] }), baseOpts),
    );
    expect(scenes).toEqual(["a", "b", "c", "room scale scene"]);
  });
});

/** Every angle photographed, so there are 8 alternate angles on top of the main. */
const allAngles: ProductProfile["photographedAngles"] = [
  "front",
  "45",
  "side",
  "back",
  "top",
  "bottom",
  "detail",
  "in_use",
  "packaging",
];

describe("planShots channel image limits (Update.md 2.10 and 2.12)", () => {
  const richOpts = { ...baseOpts, creditBudget: 1000, hasBoxContents: true, hasComparisonFacts: true };
  const onSpec = (list: ShotList, specId: string) => list.shots.filter((s) => s.channels.includes(specId));

  it("caps a pack with 9 or more secondary shots at 8 and keeps 2 lifestyle scenes and the infographic", () => {
    const list = planShots(
      profile({ photographedAngles: allAngles, missingAnglesNeeded: [], useContexts: ["a", "b", "c", "d"] }),
      { ...richOpts, channels: ["amazon"] },
    );
    const secondary = onSpec(list, "amazon.secondary");
    expect(secondary).toHaveLength(8);
    const count = (type: string): number => secondary.filter((s) => s.type === type).length;
    // Founder decision: 2 lifestyle scenes and the infographic keep their
    // slots, the rest go by priority (the best 5 alternate angles).
    expect(count("lifestyle")).toBe(RESERVED_GALLERY_SLOTS.find((r) => r.type === "lifestyle")!.count);
    expect(count("infographic")).toBe(1);
    expect(count("alt_angle_white")).toBe(5);
    expect(secondary.filter((s) => s.type === "alt_angle_white").map((s) => s.scene)).toEqual([
      "45 angle on white",
      "side angle on white",
      "back angle on white",
      "top angle on white",
      "bottom angle on white",
    ]);
    // The best two scenes by plan order are the ones kept.
    expect(secondary.filter((s) => s.type === "lifestyle").map((s) => s.scene)).toEqual(["a", "b"]);

    // 8 angles, cutout, 2 sweeps, 4 scenes, infographic, dimensions, in the
    // box and comparison: 19 secondary candidates, 8 slots, 11 extras.
    const extras = list.skipped.filter((s) => s.reason === CHANNEL_LIMIT_REASON).map((s) => s.type).sort();
    expect(extras).toEqual(
      [
        "alt_angle_white",
        "alt_angle_white",
        "alt_angle_white",
        "comparison",
        "cutout_png",
        "dimensions",
        "in_the_box",
        "lifestyle",
        "lifestyle",
        "sweep_brand",
        "sweep_gray",
      ].sort(),
    );
    // Extras are not in the plan, so they are never reserved or charged.
    const planned = new Set(list.shots.map((s) => s.id));
    expect(list.shots.length).toBe(planned.size);
    expect(channelLimitViolations(list.shots)).toEqual([]);
    expect(() => ShotList.parse(list)).not.toThrow();
  });

  it("fills the rest by priority when fewer lifestyle scenes are planned than reserved", () => {
    const list = planShots(
      profile({ photographedAngles: allAngles, missingAnglesNeeded: [], benefits: [] }),
      { ...richOpts, channels: ["amazon"], undeliverableMethods: ["composite_generate"] },
    );
    const secondary = onSpec(list, "amazon.secondary");
    expect(secondary).toHaveLength(8);
    // No scene and no infographic to reserve for: all 8 alternate angles.
    expect(secondary.every((s) => s.type === "alt_angle_white")).toBe(true);
  });

  it("keeps an extra shot for its other channels instead of dropping it", () => {
    const list = planShots(
      profile({ photographedAngles: allAngles, missingAnglesNeeded: [], useContexts: ["a", "b", "c", "d"] }),
      { ...richOpts, channels: ["amazon", "shopify"] },
    );
    expect(onSpec(list, "amazon.secondary")).toHaveLength(8);
    const lifestyle = list.shots.filter((s) => s.type === "lifestyle");
    expect(lifestyle).toHaveLength(4);
    expect(lifestyle.map((s) => s.channels)).toEqual([
      ["amazon.secondary", "shopify.product"],
      ["amazon.secondary", "shopify.product"],
      ["shopify.product"],
      ["shopify.product"],
    ]);
    const alternates = list.shots.filter((s) => s.type === "alt_angle_white");
    expect(alternates).toHaveLength(8);
    expect(alternates.filter((s) => s.channels.includes("amazon.secondary"))).toHaveLength(5);
    expect(alternates.every((s) => s.channels.includes("shopify.product"))).toBe(true);
    expect(list.skipped.some((s) => s.reason === CHANNEL_LIMIT_REASON)).toBe(false);
  });

  it("gives a slot freed by the budget trim to a shot the limit had pushed out", () => {
    const budget = 5;
    const list = planShots(
      profile({ photographedAngles: allAngles, missingAnglesNeeded: [], useContexts: ["a", "b", "c", "d"] }),
      { ...baseOpts, channels: ["amazon"], creditBudget: budget },
    );
    const total = list.shots.reduce((sum, s) => sum + s.credits, 0);
    expect(total).toBeLessThanOrEqual(budget);
    // Lifestyle scenes (priority 4, 1 credit) are trimmed for budget before
    // the white angles, and each slot they free is filled again.
    const secondary = onSpec(list, "amazon.secondary");
    expect(secondary).toHaveLength(8);
    expect(secondary.filter((s) => s.type === "infographic")).toHaveLength(1);
    expect(secondary.filter((s) => s.type === "alt_angle_white")).toHaveLength(6);
    expect(list.skipped.filter((s) => s.type === "lifestyle" && s.reason === "credit budget").length).toBeGreaterThan(0);
    expect(channelLimitViolations(list.shots)).toEqual([]);
    // The seller's first use context keeps its scene; later ones go first.
    expect(list.shots.filter((s) => s.type === "lifestyle").map((s) => s.scene)).toEqual(["a"]);
    // Every skipped shot is recorded once.
    const lifestyles = list.shots.filter((s) => s.type === "lifestyle").length;
    expect(lifestyles + list.skipped.filter((s) => s.type === "lifestyle").length).toBe(4);
  });

  it("applies the reservation to a shot list capped directly, as the LLM plan check does", () => {
    const base = planShots(profile(), { ...baseOpts, channels: ["amazon"] }).shots;
    const angle = base.find((s) => s.type === "alt_angle_white")!;
    const scene = base.find((s) => s.type === "lifestyle")!;
    const angles = Array.from({ length: 9 }, (_, i) => ({ ...angle, id: `a${i}`, channels: ["amazon.secondary"] }));
    const scenes = Array.from({ length: 3 }, (_, i) => ({ ...scene, id: `l${i}`, channels: ["amazon.secondary"] }));
    const skipped: ShotList["skipped"] = [];
    const capped = capShotsPerChannel([...angles, ...scenes], skipped);
    expect(capped.map((s) => s.id)).toEqual(["a0", "a1", "a2", "a3", "a4", "a5", "l0", "l1"]);
    expect(skipped).toHaveLength(4);
    // With no reservations the limit goes by priority alone.
    const plain = capShotsPerChannel([...angles, ...scenes], [], []);
    expect(plain.every((s) => s.type === "alt_angle_white")).toBe(true);
  });

  it("leaves a pack under the limit untouched", () => {
    const list = planShots(profile(), baseOpts);
    expect(onSpec(list, "amazon.secondary").length).toBeLessThanOrEqual(8);
    expect(list.skipped.some((s) => s.reason === CHANNEL_LIMIT_REASON)).toBe(false);
    expect(onSpec(list, "amazon.main")).toHaveLength(1);
  });

  it("flags a second amazon.main and a ninth amazon.secondary in any shot list", () => {
    const base = planShots(profile(), baseOpts).shots;
    const main = base.find((s) => s.type === "amazon_main")!;
    const twoMains = [...base, { ...main, id: "s99_amazon_main" }];
    expect(channelLimitViolations(twoMains)).toEqual([{ specId: "amazon.main", count: 2, limit: 1 }]);

    const secondary = base.find((s) => s.channels.includes("amazon.secondary"))!;
    const nine = Array.from({ length: 9 }, (_, i) => ({ ...secondary, id: `x${i}`, channels: ["amazon.secondary"] }));
    expect(channelLimitViolations(nine)).toEqual([{ specId: "amazon.secondary", count: 9, limit: 8 }]);
  });

  it("caps a shot list directly, keeping the first main and skipping the second", () => {
    const base = planShots(profile(), baseOpts).shots;
    const main = base.find((s) => s.type === "amazon_main")!;
    const skipped: ShotList["skipped"] = [];
    const capped = capShotsPerChannel([main, { ...main, id: "second_main" }], skipped);
    expect(capped.map((s) => s.id)).toEqual([main.id]);
    expect(skipped).toEqual([{ type: "amazon_main", reason: CHANNEL_LIMIT_REASON }]);
  });
});

const VIDEO_TYPES = ["video_spin", "video_hero_6s", "video_lifestyle_15s", "video_ugc_hook"];

describe("planShots undeliverable methods", () => {
  const undeliverable: Array<Shot["method"]> = ["video_generate", "avatar"];

  it("skips shots whose method production cannot deliver, once each, with a clear reason", () => {
    const list = planShots(profile(), { ...baseOpts, tier: "pro", creditBudget: 200, undeliverableMethods: undeliverable });
    expect(list.shots.some((s) => undeliverable.includes(s.method))).toBe(false);
    for (const type of VIDEO_TYPES) {
      expect(list.skipped.filter((s) => s.type === type)).toEqual([{ type, reason: UNDELIVERABLE_METHOD_REASON }]);
    }
    // Without the option the same plan still proposes them.
    const plain = planShots(profile(), { ...baseOpts, tier: "pro", creditBudget: 200 });
    expect(plain.shots.filter((s) => VIDEO_TYPES.includes(s.type))).toHaveLength(4);
  });

  it("says the shot cannot be made yet instead of a tier or photo reason", () => {
    const twoAngles = profile({ photographedAngles: ["front", "45"] });
    const starter = planShots(twoAngles, { ...baseOpts, tier: "starter", undeliverableMethods: undeliverable });
    for (const type of VIDEO_TYPES) {
      expect(starter.skipped.filter((s) => s.type === type), type).toEqual([{ type, reason: UNDELIVERABLE_METHOD_REASON }]);
    }
    // Without the option the tier and photo reasons stay.
    const plain = planShots(twoAngles, { ...baseOpts, tier: "starter" });
    expect(plain.skipped.find((s) => s.type === "video_spin")?.reason).toBe("needs photo");
    expect(plain.skipped.find((s) => s.type === "video_hero_6s")?.reason).toBe("not included in this plan tier");
  });

  it("removes them before the budget trim, so they never cost a shot that ships", () => {
    // Video is selected, so a planned video shot would compete for the budget.
    const channels = ["amazon", "video"];
    const roomy = planShots(profile(), {
      ...baseOpts,
      channels,
      tier: "pro",
      creditBudget: 1000,
      undeliverableMethods: undeliverable,
    });
    const need = roomy.shots.reduce((sum, s) => sum + s.credits, 0);
    const exact = planShots(profile(), {
      ...baseOpts,
      channels,
      tier: "pro",
      creditBudget: need,
      undeliverableMethods: undeliverable,
    });
    expect(exact.shots.map((s) => s.id)).toEqual(roomy.shots.map((s) => s.id));
    expect(exact.skipped.some((s) => s.reason === "credit budget")).toBe(false);
    // Without the option the video shots are planned, and the same budget
    // has to trim them.
    const unfiltered = planShots(profile(), { ...baseOpts, channels, tier: "pro", creditBudget: need });
    expect(unfiltered.skipped.filter((s) => s.reason === "credit budget").map((s) => s.type).sort()).toEqual(
      [...VIDEO_TYPES].sort(),
    );
  });

  it("takes the seed's undeliverable list as is", () => {
    const list = planShots(profile(), { ...baseOpts, tier: "agency", undeliverableMethods: undeliverableShotMethods });
    expect(list.shots.some((s) => undeliverableShotMethods.includes(s.method))).toBe(false);
  });
});

/** White images only: the main image and the angles on white. */
const WHITE_TYPES = ["amazon_main", "alt_angle_white"];
/** Shot types that carry copy on the image. */
const TEXT_TYPES = ["infographic", "dimensions", "in_the_box", "comparison"];

describe("planShots marketplaces beyond Amazon, Shopify and Google", () => {
  const mediaIdsByAngle = Object.fromEntries(allAngles.map((angle) => [angle, `media_${angle}`]));
  const opts = (channels: string[], extra: Partial<Parameters<typeof planShots>[1]> = {}) => ({
    ...baseOpts,
    channels,
    creditBudget: 100,
    hasBoxContents: true,
    hasComparisonFacts: true,
    mediaIdsByAngle,
    ...extra,
  });
  const on = (list: ShotList, specId: string): Shot[] => list.shots.filter((s) => s.channels.includes(specId));
  const skippedAs = (list: ShotList, reason: string): string[] =>
    list.skipped.filter((s) => s.reason === reason).map((s) => s.type);

  /** The registry rules every planned file for this spec must meet. */
  function expectCompliant(list: ShotList, specId: string): Shot[] {
    const spec = getSpec(specId);
    const shots = on(list, specId);
    expect(shots.length).toBeGreaterThan(0);
    // Deterministic and template images only: nothing generated.
    for (const shot of shots) {
      expect(["deterministic", "template"], `${shot.type} on ${specId}`).toContain(shot.method);
    }
    // The white front image leads the listing.
    expect(WHITE_TYPES).toContain(shots[0].type);
    expect(shots[0]).toMatchObject({ method: "deterministic", sourceMediaId: "media_front", priority: 1 });
    // Count, text and background rules from the registry.
    const limit = channelFileLimit(spec);
    if (limit !== null) {
      expect(shots.length).toBeLessThanOrEqual(limit);
    }
    if (spec.textAllowed === false) {
      expect(shots.filter((s) => TEXT_TYPES.includes(s.type))).toEqual([]);
    }
    if (spec.background?.type === "solid" || spec.background?.type === "white_preferred") {
      expect(shots.filter((s) => !WHITE_TYPES.includes(s.type)).map((s) => s.type)).toEqual([]);
    }
    expect(channelLimitViolations(list.shots)).toEqual([]);
    expect(() => ShotList.parse(list)).not.toThrow();
    return shots;
  }

  it("plans an Etsy listing: white front first, angles, cutout, sweeps and the text images", () => {
    const list = planShots(profile(), opts(["etsy.listing"]));
    const shots = expectCompliant(list, "etsy.listing");
    expect(shots[0]).toMatchObject({ type: "alt_angle_white", scene: "front angle on white", channels: ["etsy.listing"] });
    const types = shots.map((s) => s.type);
    for (const type of ["cutout_png", "sweep_gray", "sweep_brand", "infographic", "dimensions", "in_the_box", "comparison"]) {
      expect(types, type).toContain(type);
    }
    expect(types.filter((t) => t === "alt_angle_white")).toHaveLength(4);
    // No generated scene ships to Etsy, and nothing falls back to Shopify.
    expect(skippedAs(list, NO_COMPATIBLE_CHANNEL_REASON).filter((t) => t === "lifestyle")).toHaveLength(2);
    expect(on(list, "shopify.product")).toEqual([]);
    // A family string selects the same plan.
    expect(planShots(profile(), opts(["etsy"])).shots).toEqual(list.shots);
  });

  it("plans an eBay listing without images that carry text", () => {
    const list = planShots(profile(), opts(["ebay.listing"]));
    const types = expectCompliant(list, "ebay.listing").map((s) => s.type);
    expect(types).toEqual(expect.arrayContaining(["cutout_png", "sweep_gray", "sweep_brand"]));
    expect(skippedAs(list, NO_COMPATIBLE_CHANNEL_REASON).sort()).toEqual(
      ["comparison", "dimensions", "in_the_box", "infographic", "lifestyle", "lifestyle"].sort(),
    );
  });

  it("plans Walmart files on pure white only", () => {
    const list = planShots(profile(), opts(["walmart.main"]));
    const shots = expectCompliant(list, "walmart.main");
    expect(shots.map((s) => s.type)).toEqual(["alt_angle_white", "alt_angle_white", "alt_angle_white", "alt_angle_white"]);
    expect(skippedAs(list, NO_COMPATIBLE_CHANNEL_REASON).sort()).toEqual(
      [
        "comparison",
        "cutout_png",
        "dimensions",
        "in_the_box",
        "infographic",
        "lifestyle",
        "lifestyle",
        "sweep_brand",
        "sweep_gray",
      ].sort(),
    );
  });

  it("plans TikTok Shop files on white, one per angle, within its 9 image limit", () => {
    const list = planShots(profile({ photographedAngles: allAngles, missingAnglesNeeded: [] }), opts(["tiktokshop.main"]));
    const shots = expectCompliant(list, "tiktokshop.main");
    // The front plus 8 other angles: exactly the limit, each angle once.
    expect(shots).toHaveLength(channelFileLimit(getSpec("tiktokshop.main"))!);
    expect(new Set(shots.map((s) => s.sourceMediaId)).size).toBe(shots.length);
    expect(skippedAs(list, CHANNEL_LIMIT_REASON)).toEqual([]);
  });

  it("plans one 2:3 pin for Pinterest with the social template", () => {
    const list = planShots(profile(), opts(["pinterest.pin"]));
    const pins = on(list, "pinterest.pin");
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ type: "social_2x3", method: "template", channels: ["pinterest.pin"] });
    const bounds = dimensionBounds(getSpec("pinterest.pin"));
    expect(bounds.maxWidth / bounds.maxHeight).toBeCloseTo(2 / 3, 5);
    // Not planned unless Pinterest is selected.
    expect(planShots(profile(), opts(["amazon"])).shots.some((s) => s.type === "social_2x3")).toBe(false);
  });

  it("keeps the pin when the budget is tight, trimming shots for unselected channels first", () => {
    const list = planShots(profile(), opts(["pinterest"], { creditBudget: 0.5 }));
    expect(list.shots.map((s) => s.type)).toEqual(["social_2x3"]);
    expect(list.skipped.filter((s) => s.reason === "credit budget")).toEqual([]);
    expect(skippedAs(list, CHANNEL_NOT_SELECTED_REASON)).toContain("lifestyle");
  });

  it("lets the Amazon main image lead the other marketplaces instead of a second front shot", () => {
    const list = planShots(profile(), opts(["amazon", "etsy", "walmart", "tiktokshop", "ebay"]));
    const main = list.shots.find((s) => s.type === "amazon_main")!;
    expect(main.channels).toEqual(["amazon.main", "etsy.listing", "ebay.listing", "walmart.main", "tiktokshop.main"]);
    expect(list.shots.filter((s) => s.priority === 1)).toEqual([main]);
    for (const specId of ["etsy.listing", "ebay.listing", "walmart.main", "tiktokshop.main"]) {
      expect(expectCompliant(list, specId)[0]).toBe(main);
    }
    // Generated scenes still reach Amazon, never the newer marketplaces.
    const lifestyle = list.shots.filter((s) => s.type === "lifestyle");
    expect(lifestyle.length).toBeGreaterThan(0);
    for (const shot of lifestyle) {
      expect(shot.channels).toEqual(["amazon.secondary"]);
    }
  });

  it("skips the white front image with needs photo when the front photo cannot lead", () => {
    const list = planShots(profile({ imageQuality: { usableForMain: false, issues: ["blur"] } }), opts(["etsy"]));
    expect(list.skipped).toContainEqual({ type: "alt_angle_white:front", reason: "needs photo" });
    expect(on(list, "etsy.listing").filter((s) => s.priority === 1)).toEqual([]);
    expect(on(list, "etsy.listing").some((s) => s.type === "alt_angle_white")).toBe(true);
  });

  it("gives every image channel family in the registry files when all are selected", () => {
    const list = planShots(profile(), { ...opts(listSpecs().map((s) => s.id)), tier: "agency", creditBudget: 10_000 });
    const families = new Set(list.shots.flatMap((s) => s.channels.map((c) => c.split(".")[0])));
    for (const family of new Set(listSpecs().map((s) => s.id.split(".")[0]))) {
      expect(families.has(family), family).toBe(true);
    }
    expect(channelLimitViolations(list.shots)).toEqual([]);
  });

  it("stops sending text images to Google, whose lifestyle spec allows no text", () => {
    const list = planShots(profile(), opts(["google"]));
    expect(on(list, "google.merchant.lifestyle").filter((s) => TEXT_TYPES.includes(s.type))).toEqual([]);
    expect(skippedAs(list, NO_COMPATIBLE_CHANNEL_REASON)).toEqual(
      expect.arrayContaining(["infographic", "dimensions", "in_the_box", "comparison"]),
    );
    expect(on(list, "google.merchant.lifestyle").some((s) => s.type === "lifestyle")).toBe(true);
  });
});

describe("specAcceptsImage", () => {
  const accepts = (specId: string) =>
    (["white", "transparent", "colored", "text", "generated"] as const).filter((kind) =>
      specAcceptsImage(getSpec(specId), kind),
    );

  it("reads each listing spec's background, text and format rules", () => {
    expect(accepts("amazon.secondary")).toEqual(["white", "transparent", "colored", "text", "generated"]);
    expect(accepts("shopify.product")).toEqual(["white", "transparent", "colored", "text", "generated"]);
    expect(accepts("google.merchant.lifestyle")).toEqual(["white", "transparent", "colored", "generated"]);
    expect(accepts("etsy.listing")).toEqual(["white", "transparent", "colored", "text", "generated"]);
    expect(accepts("ebay.listing")).toEqual(["white", "transparent", "colored", "generated"]);
    expect(accepts("walmart.main")).toEqual(["white"]);
    expect(accepts("tiktokshop.main")).toEqual(["white"]);
  });

  it("refuses white on a solid background of another color", () => {
    const spec = {
      ...getSpec("walmart.main"),
      background: { type: "solid" as const, rgb: [240, 240, 240] as [number, number, number] },
    };
    expect(specAcceptsImage(spec, "white")).toBe(false);
  });
});
