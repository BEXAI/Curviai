import { describe, expect, it } from "vitest";
import { ShotList, type ProductProfile } from "../schemas";
import { CHANNEL_LIMIT_REASON, capShotsPerChannel, channelLimitViolations, planShots } from "./deterministic";

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

  it("caps a pack with 9 or more secondary shots at 8 and skips the extras", () => {
    const list = planShots(
      profile({ photographedAngles: allAngles, missingAnglesNeeded: [], useContexts: ["a", "b", "c", "d"] }),
      { ...richOpts, channels: ["amazon"] },
    );
    expect(onSpec(list, "amazon.secondary")).toHaveLength(8);
    const extras = list.skipped.filter((s) => s.reason === CHANNEL_LIMIT_REASON);
    // 8 angles, cutout, 2 sweeps, 4 scenes, infographic, dimensions, in the
    // box and comparison: 19 secondary candidates, 8 slots.
    expect(extras).toHaveLength(11);
    // Best priority first: the 8 kept are the alternate angles (priority 2).
    for (const shot of onSpec(list, "amazon.secondary")) {
      expect(shot.priority).toBe(2);
    }
    // Extras are not in the plan, so they are never reserved or charged.
    const planned = new Set(list.shots.map((s) => s.id));
    expect(list.shots.length).toBe(planned.size);
    expect(list.shots.some((s) => s.type === "lifestyle")).toBe(false);
    expect(channelLimitViolations(list.shots)).toEqual([]);
    expect(() => ShotList.parse(list)).not.toThrow();
  });

  it("keeps an extra shot for its other channels instead of dropping it", () => {
    const list = planShots(
      profile({ photographedAngles: allAngles, missingAnglesNeeded: [], useContexts: ["a", "b", "c", "d"] }),
      { ...richOpts, channels: ["amazon", "shopify"] },
    );
    expect(onSpec(list, "amazon.secondary")).toHaveLength(8);
    const lifestyle = list.shots.filter((s) => s.type === "lifestyle");
    expect(lifestyle).toHaveLength(4);
    for (const shot of lifestyle) {
      expect(shot.channels).toEqual(["shopify.product"]);
    }
    expect(list.skipped.some((s) => s.reason === CHANNEL_LIMIT_REASON)).toBe(false);
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
