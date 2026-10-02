import { describe, expect, it } from "vitest";
import {
  channelFileLimit,
  dimensionBounds,
  getSpec,
  isSpecSelected,
  listSpecs,
  refusesOverlays,
  requiresWhiteBackground,
} from "@curvi/specs";
import {
  ADDED_OVERLAYS_REASON,
  EXTRA_FAMILIES,
  SELLER_OFF_REASON,
  SOURCE_TOO_SMALL_REASON,
  type OutputExtras,
  type OutputPlanFlags,
  type PlanPhoto,
} from "../output-options";
import { creditCosts, undeliverableShotMethods } from "../seed/credits";
import { lifestyleFallbackScenes, sceneCountOptions } from "../seed/templates";
import { ShotList, type ProductProfile, type Shot } from "../schemas";
import {
  CHANNEL_LIMIT_REASON,
  CHANNEL_NOT_SELECTED_REASON,
  CREDIT_BUDGET_REASON,
  NO_COMPATIBLE_CHANNEL_REASON,
  RESERVED_GALLERY_SLOTS,
  SCENE_COUNT_REASON,
  UNDELIVERABLE_METHOD_REASON,
  applyAddedOverlays,
  applyOriginalSizes,
  capSceneCount,
  capShotsPerChannel,
  channelLimitViolations,
  coverSellerOffSpecs,
  lifestyleScenesFor,
  planShots,
  printableDimensions,
  reservedSlotsFor,
  skipSellerOffShots,
  specAcceptsImage,
  trimToBudget,
  type PlanOptions,
  type SkippedShot,
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

/** Marketplace ready flags with the seller's number of scenes. */
function sceneFlags(sceneCount: number): OutputPlanFlags {
  return {
    background: "remove",
    keepMediaIds: [],
    extras: { scenes: true, backdrops: true, transparentPng: true, graphics: true, cards: true },
    fit: "auto",
    photos: [],
    sceneCount,
  };
}

const baseOpts = {
  // Video is picked too: the planner only plans shots for picked specs.
  channels: ["amazon", "shopify", "meta", "video"],
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
    // Every picked spec whose best shot fits keeps a file: the social crops
    // (priority 7) stay while gallery extras go. The 6 credit hero loop does
    // not fit next to them, so its spec goes without.
    for (const specId of ["amazon.main", "amazon.secondary", "shopify.product", "meta.feed_1x1", "meta.story_9x16"]) {
      expect(tight.shots.some((s) => s.channels.includes(specId)), specId).toBe(true);
    }
    expect(tight.shots.some((s) => s.channels.includes("video.social_9x16"))).toBe(false);
    // Apart from the one shot that keeps each picked spec's file, dropped
    // shots are the low priority ones: every other kept shot has priority no
    // worse than anything dropped for budget.
    const soleFile = (shot: Shot): boolean =>
      shot.channels.some((c) => tight.shots.filter((s) => s.channels.includes(c)).length === 1);
    const maxKept = Math.max(...tight.shots.filter((s) => !soleFile(s)).map((s) => s.priority));
    for (const skip of tight.skipped.filter((s) => s.reason === "credit budget")) {
      const match = generous.shots.find((s) => s.type === skip.type);
      if (match && !match.channels.every((c) => tight.shots.some((s) => s.channels.includes(c)))) {
        continue;
      }
      if (match) {
        expect(match.priority, skip.type).toBeGreaterThanOrEqual(maxKept);
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

  it("never plans a dimensions label longer than a callout may be", () => {
    // 47 characters with a metric conversion: the conversion is dropped.
    const long = "12.5 x 8.25 x 4 inches (31.75 x 20.96 x 10.2 cm)";
    const plan = planShots(profile({ dimensions: { value: long, source: "user" } }), baseOpts);
    expect(() => ShotList.parse(plan)).not.toThrow();
    expect(plan.shots.find((s) => s.type === "dimensions")?.callouts).toEqual(["12.5 x 8.25 x 4 inches"]);
    // A label that cannot be printed whole is skipped, never cut mid figure.
    const unprintable = "12.5 inches wide by 8.25 inches deep by 4 inches tall";
    const skipped = planShots(profile({ dimensions: { value: unprintable, source: "packaging" } }), baseOpts);
    expect(() => ShotList.parse(skipped)).not.toThrow();
    expect(skipped.shots.some((s) => s.type === "dimensions")).toBe(false);
    expect(skipped.skipped.find((s) => s.type === "dimensions")?.reason).toContain("too long to print");
  });

  it("keeps a dimensions label whole or not at all", () => {
    expect(printableDimensions("  10 x 10 x 12 cm ")).toBe("10 x 10 x 12 cm");
    expect(printableDimensions("")).toBeNull();
    expect(printableDimensions("x".repeat(41))).toBeNull();
    expect(printableDimensions("x".repeat(40))).toBe("x".repeat(40));
  });

  it("plans in_the_box and comparison only when the seller supplied facts", () => {
    const bare = planShots(profile(), baseOpts);
    expect(bare.shots.some((s) => s.type === "in_the_box")).toBe(false);
    expect(bare.shots.some((s) => s.type === "comparison")).toBe(false);
    const rich = planShots(profile(), { ...baseOpts, hasBoxContents: true, hasComparisonFacts: true });
    expect(rich.shots.some((s) => s.type === "in_the_box")).toBe(true);
    expect(rich.shots.some((s) => s.type === "comparison")).toBe(true);
  });

  it("prints the seller's box contents and comparison facts, and draws in_the_box from the in the box photo", () => {
    const plan = planShots(profile(), {
      ...baseOpts,
      boxContents: ["Mug", "  Pour   over cone ", "", "Mug", "x".repeat(41)],
      comparisonFacts: ["Holds 12 oz, most hold 8 oz"],
      mediaIdsByAngle: { front: "m_front", packaging: "m_box" },
      primaryMediaId: "m_front",
    });
    const box = plan.shots.find((s) => s.type === "in_the_box");
    const comparison = plan.shots.find((s) => s.type === "comparison");
    // Trimmed, deduped, and a line too long to print whole is dropped, never cut.
    expect(box?.callouts).toEqual(["Mug", "Pour over cone"]);
    expect(box?.sourceMediaId).toBe("m_box");
    expect(comparison?.callouts).toEqual(["Holds 12 oz, most hold 8 oz"]);
    expect(comparison?.sourceMediaId).toBe("m_front");
    // Lists alone count as supplied facts; empty lists do not.
    const empty = planShots(profile(), { ...baseOpts, boxContents: [" "], comparisonFacts: [] });
    expect(empty.shots.some((s) => s.type === "in_the_box" || s.type === "comparison")).toBe(false);
    expect(empty.skipped.map((s) => s.type)).toEqual(expect.arrayContaining(["in_the_box", "comparison"]));
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

  it("plans between the seeded scene bounds of lifestyle scenes", () => {
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

  it("gives apparel with no contexts the default scenes including ghost style", () => {
    const scenes = lifestyleScenes(planShots(apparel([]), baseOpts));
    expect(scenes.length).toBeGreaterThanOrEqual(2);
    expect(scenes.length).toBeLessThanOrEqual(4);
    expect(scenes).toContain(GHOST);
  });

  it("keeps ghost style when apparel has 5 contexts", () => {
    const scenes = lifestyleScenes(planShots(apparel(["beach", "office", "gym", "park", "cafe"]), baseOpts));
    expect(scenes).toHaveLength(sceneCountOptions.default);
    expect(scenes).toContain(GHOST);
    expect(scenes.filter((s) => s.startsWith("flat lay, "))).toHaveLength(sceneCountOptions.default - 1);
  });

  it("dedupes repeated apparel contexts and still meets the minimum", () => {
    const scenes = lifestyleScenes(planShots(apparel(["beach", "beach"]), baseOpts));
    expect(new Set(scenes).size).toBe(scenes.length);
    expect(scenes.length).toBeGreaterThanOrEqual(2);
    expect(scenes).toContain(GHOST);
  });

  it("uses the seller's contexts without flat lay or ghost style when on model photos exist", () => {
    const scenes = lifestyleScenes(planShots(apparel(["beach", "office"], ["front", "in_use"]), baseOpts));
    // The seed's first fallback scene fills the default count of 3.
    expect(scenes).toEqual(["beach", "office", lifestyleFallbackScenes[0]]);
  });

  it("keeps the jewelry additions when there are 4 or more contexts", () => {
    const scenes = lifestyleScenes(
      planShots(profile({ category: "jewelry", useContexts: ["a", "b", "c", "d", "e"] }), baseOpts),
    );
    expect(scenes).toHaveLength(sceneCountOptions.default);
    expect(scenes).toContain("detail macro");
    expect(scenes).toContain("scale next to a familiar object");
    expect(scenes).not.toContain("scale on hand");
  });

  it("keeps a single category addition next to 4 contexts", () => {
    const scenes = lifestyleScenes(
      planShots(profile({ category: "furniture", useContexts: ["a", "b", "c", "d"] }), baseOpts),
    );
    expect(scenes).toEqual(["a", "b", "room scale scene"]);
  });
});

describe("number of scenes (PHASE_15 P1, founder decision 4)", () => {
  const CATEGORIES: ProductProfile["category"][] = [
    "apparel",
    "jewelry",
    "food_beverage",
    "furniture",
    "electronics",
    "home_kitchen",
    "beauty",
    "pet",
  ];
  const CONTEXTS: string[][] = [[], ["a"], ["a", "a"], ["a", "b", "c", "d", "e", "f"]];

  it("plans exactly n scenes for every category, n from the seed bounds, category scenes first", () => {
    for (let n = sceneCountOptions.min; n <= sceneCountOptions.max; n++) {
      for (const category of CATEGORIES) {
        for (const useContexts of CONTEXTS) {
          const product = profile({ category, useContexts });
          const scenes = lifestyleScenesFor(product, n);
          expect(scenes, `${category} ${n} ${useContexts.join(",")}`).toHaveLength(n);
          expect(new Set(scenes).size).toBe(n);
          const planned = lifestyleScenes(planShots(product, { ...baseOpts, creditBudget: 1000, output: sceneFlags(n) }));
          expect(planned).toEqual(scenes);
        }
      }
    }
    // With one scene, jewelry keeps its first category scene.
    expect(lifestyleScenesFor(profile({ category: "jewelry", useContexts: ["a"] }), 1)).toEqual(["detail macro"]);
  });

  it("plans the seed default when the pack names no count", () => {
    expect(lifestyleScenes(planShots(profile(), baseOpts))).toHaveLength(sceneCountOptions.default);
    expect(lifestyleScenesFor(profile())).toHaveLength(sceneCountOptions.default);
  });

  it("changes the credits by exactly one scene per step", () => {
    const totalFor = (n: number): number =>
      planShots(profile(), { ...baseOpts, creditBudget: 1000, output: sceneFlags(n) }).shots.reduce(
        (sum, s) => sum + s.credits,
        0,
      );
    for (let n = sceneCountOptions.min; n < sceneCountOptions.max; n++) {
      expect(totalFor(n + 1) - totalFor(n)).toBe(creditCosts.generativeStill);
    }
  });

  it("reserves the pack's scene count on a full gallery", () => {
    expect(reservedSlotsFor([], 4).find((r) => r.type === "lifestyle")?.count).toBe(4);
    expect(reservedSlotsFor([]).find((r) => r.type === "lifestyle")?.count).toBe(sceneCountOptions.default);
    const list = planShots(
      profile({ photographedAngles: allAngles, missingAnglesNeeded: [], useContexts: ["a", "b", "c", "d"] }),
      { ...baseOpts, creditBudget: 1000, channels: ["amazon"], output: sceneFlags(4) },
    );
    const secondary = list.shots.filter((s) => s.channels.includes("amazon.secondary"));
    expect(secondary.filter((s) => s.type === "lifestyle")).toHaveLength(4);
  });

  it("capSceneCount keeps the first n scenes of a plan it did not make", () => {
    const base = planShots(profile(), { ...baseOpts, creditBudget: 1000 }).shots;
    const scene = base.find((s) => s.type === "lifestyle")!;
    const scenes = Array.from({ length: 4 }, (_, i) => ({ ...scene, id: `l${i}` }));
    const skipped: SkippedShot[] = [];
    const out = capSceneCount([...scenes, base[0]], { sceneCount: 2 }, skipped);
    expect(out.map((s) => s.id)).toEqual(["l0", "l1", base[0].id]);
    expect(skipped).toEqual([
      { type: "lifestyle", reason: SCENE_COUNT_REASON },
      { type: "lifestyle", reason: SCENE_COUNT_REASON },
    ]);
    expect(capSceneCount(scenes, undefined, []).length).toBe(sceneCountOptions.default);
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

  it("caps a pack with 9 or more secondary shots at 8 and keeps the scene count and the infographic", () => {
    const list = planShots(
      profile({ photographedAngles: allAngles, missingAnglesNeeded: [], useContexts: ["a", "b", "c", "d"] }),
      { ...richOpts, channels: ["amazon"] },
    );
    const secondary = onSpec(list, "amazon.secondary");
    expect(secondary).toHaveLength(8);
    const count = (type: string): number => secondary.filter((s) => s.type === type).length;
    // Founder decisions: the pack's scenes (3 by default) and the
    // infographic keep their slots, the rest go by priority (the best 4
    // alternate angles).
    expect(count("lifestyle")).toBe(RESERVED_GALLERY_SLOTS.find((r) => r.type === "lifestyle")!.count);
    expect(count("lifestyle")).toBe(sceneCountOptions.default);
    expect(count("infographic")).toBe(1);
    expect(count("alt_angle_white")).toBe(4);
    expect(secondary.filter((s) => s.type === "alt_angle_white").map((s) => s.scene)).toEqual([
      "45 angle on white",
      "side angle on white",
      "back angle on white",
      "top angle on white",
    ]);
    // The pack plans its first three contexts, and all three are kept.
    expect(secondary.filter((s) => s.type === "lifestyle").map((s) => s.scene)).toEqual(["a", "b", "c"]);

    // 8 angles, cutout, 2 sweeps, 3 scenes, infographic, dimensions, in the
    // box and comparison: 18 secondary candidates, 8 slots, 10 extras.
    const extras = list.skipped.filter((s) => s.reason === CHANNEL_LIMIT_REASON).map((s) => s.type).sort();
    expect(extras).toEqual(
      [
        "alt_angle_white",
        "alt_angle_white",
        "alt_angle_white",
        "alt_angle_white",
        "comparison",
        "cutout_png",
        "dimensions",
        "in_the_box",
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
    expect(lifestyle).toHaveLength(3);
    expect(lifestyle.map((s) => s.channels)).toEqual([
      ["amazon.secondary", "shopify.product"],
      ["amazon.secondary", "shopify.product"],
      ["amazon.secondary", "shopify.product"],
    ]);
    const alternates = list.shots.filter((s) => s.type === "alt_angle_white");
    expect(alternates).toHaveLength(8);
    // The 4 best angles keep amazon.secondary; the others ship to Shopify only.
    expect(alternates.filter((s) => s.channels.includes("amazon.secondary"))).toHaveLength(4);
    expect(alternates.every((s) => s.channels.includes("shopify.product"))).toBe(true);
    expect(list.skipped.some((s) => s.reason === CHANNEL_LIMIT_REASON)).toBe(false);
  });

  it("gives a slot freed by the budget trim to a shot the limit had pushed out", () => {
    const budget = 5;
    const list = planShots(
      profile({ photographedAngles: allAngles, missingAnglesNeeded: [], useContexts: ["a", "b", "c", "d"] }),
      // The listing specs only: a picked A+ spec would keep one banner.
      { ...baseOpts, channels: ["amazon.main", "amazon.secondary"], creditBudget: budget },
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
    expect(lifestyles + list.skipped.filter((s) => s.type === "lifestyle").length).toBe(sceneCountOptions.default);
  });

  it("applies the reservation to a shot list capped directly, as the LLM plan check does", () => {
    const base = planShots(profile(), { ...baseOpts, channels: ["amazon"] }).shots;
    const angle = base.find((s) => s.type === "alt_angle_white")!;
    const scene = base.find((s) => s.type === "lifestyle")!;
    const angles = Array.from({ length: 9 }, (_, i) => ({ ...angle, id: `a${i}`, channels: ["amazon.secondary"] }));
    const scenes = Array.from({ length: 3 }, (_, i) => ({ ...scene, id: `l${i}`, channels: ["amazon.secondary"] }));
    const skipped: ShotList["skipped"] = [];
    const capped = capShotsPerChannel([...angles, ...scenes], skipped);
    expect(capped.map((s) => s.id)).toEqual(["a0", "a1", "a2", "a3", "a4", "l0", "l1", "l2"]);
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
    // Without the option the video shots are planned and compete for the
    // same budget: the spin video keeps the picked video.amazon_listing spec
    // its file, so stills are trimmed to make room, and the video shots too
    // big for the budget go.
    const unfiltered = planShots(profile(), { ...baseOpts, channels, tier: "pro", creditBudget: need });
    const trimmed = unfiltered.skipped.filter((s) => s.reason === "credit budget").map((s) => s.type);
    expect(trimmed).toEqual(expect.arrayContaining(["video_lifestyle_15s", "video_ugc_hook"]));
    expect(unfiltered.shots.some((s) => s.type === "video_spin")).toBe(true);
    expect(trimmed.some((type) => !VIDEO_TYPES.includes(type))).toBe(true);
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
    expect(skippedAs(list, NO_COMPATIBLE_CHANNEL_REASON).filter((t) => t === "lifestyle")).toHaveLength(
      sceneCountOptions.default,
    );
    expect(on(list, "shopify.product")).toEqual([]);
    // A family string selects the same plan.
    expect(planShots(profile(), opts(["etsy"])).shots).toEqual(list.shots);
  });

  it("plans an eBay listing without images that carry text", () => {
    const list = planShots(profile(), opts(["ebay.listing"]));
    const types = expectCompliant(list, "ebay.listing").map((s) => s.type);
    expect(types).toEqual(expect.arrayContaining(["cutout_png", "sweep_gray", "sweep_brand"]));
    expect(skippedAs(list, NO_COMPATIBLE_CHANNEL_REASON).sort()).toEqual(
      ["comparison", "dimensions", "in_the_box", "infographic", "lifestyle", "lifestyle", "lifestyle"].sort(),
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

describe("planShots selects by channel spec, as the runner and the estimate do (Update.md 2.11)", () => {
  /** The product the web estimate reserves for: three angles, no confirmed size. */
  const threeAngles = profile({
    photographedAngles: ["front", "45", "back"],
    missingAnglesNeeded: [],
    dimensions: { value: "10 x 10 x 12 cm", source: "unknown" },
  });
  /** A richer product: four angles and a size the seller confirmed. */
  const fourAngles = profile({ photographedAngles: ["front", "45", "back", "top"], missingAnglesNeeded: [] });
  const DEFAULT_FORM = ["amazon.main", "amazon.secondary", "shopify.product", "meta.feed_1x1"];
  const cost = (list: ShotList): number => list.shots.reduce((sum, s) => sum + s.credits, 0);
  const SELECTIONS = [
    ["amazon.main", "etsy.listing"],
    ["amazon.main", "meta.feed_1x1"],
    ["etsy.listing", "google"],
    ["google.merchant.main"],
    ["pinterest.pin", "ebay.listing"],
    ["shopify.hero_banner"],
    ["amazon.aplus.basic_header", "walmart.main"],
    DEFAULT_FORM,
  ];

  it("never aims a shot at a spec the seller did not pick", () => {
    for (const channels of SELECTIONS) {
      for (const budget of [1, 4, 100]) {
        const list = planShots(fourAngles, { ...baseOpts, channels, tier: "agency", creditBudget: budget });
        for (const shot of list.shots) {
          expect(
            shot.channels.every((c) => isSpecSelected(channels, c)),
            `${channels.join(",")} at ${budget}: ${shot.id} on ${shot.channels.join(",")}`,
          ).toBe(true);
        }
      }
    }
  });

  it("sends amazon.main plus etsy.listing no lifestyle scene, A+ banner or crop nobody picked", () => {
    const list = planShots(profile(), { ...baseOpts, channels: ["amazon.main", "etsy.listing"] });
    const specs = new Set(list.shots.flatMap((s) => s.channels));
    expect([...specs].sort()).toEqual(["amazon.main", "etsy.listing"]);
    // The main image leads Etsy too, charged once.
    const main = list.shots.find((s) => s.type === "amazon_main")!;
    expect(main.channels).toEqual(["amazon.main", "etsy.listing"]);
    // Scenes only ship to amazon.secondary here, which was not picked.
    expect(list.shots.some((s) => s.type === "lifestyle")).toBe(false);
    expect(list.skipped).toContainEqual({ type: "lifestyle", reason: NO_COMPATIBLE_CHANNEL_REASON });
    for (const type of ["aplus_banner", "social_1x1", "social_4x5", "social_9x16"]) {
      expect(list.skipped, type).toContainEqual({ type, reason: CHANNEL_NOT_SELECTED_REASON });
    }
  });

  it("never trims a shipping shot while a shot that would not ship is kept", () => {
    const channels = ["amazon.main", "etsy.listing"];
    for (let budget = 0.5; budget <= 6; budget += 0.5) {
      const list = planShots(fourAngles, { ...baseOpts, channels, creditBudget: budget });
      expect(cost(list)).toBeLessThanOrEqual(budget);
      // Everything kept ships to a picked spec, so a trim only ever removed
      // shots that ship when nothing else was left to remove.
      expect(list.shots.every((s) => s.channels.some((c) => isSpecSelected(channels, c)))).toBe(true);
      expect(list.skipped.some((s) => s.reason === CHANNEL_NOT_SELECTED_REASON && s.type === "alt_angle_white")).toBe(
        false,
      );
    }
    // The trim itself drops shots for unpicked specs first, whatever their priority.
    const ship = (id: string, channels: string[], priority: number): Shot => ({
      id,
      type: "alt_angle_white",
      sourceMediaId: "m1",
      method: "deterministic",
      channels,
      stylePreset: "none",
      credits: 0.5,
      priority,
    });
    const skipped: ShotList["skipped"] = [];
    const kept = trimToBudget(
      [ship("a", ["etsy.listing"], 9), ship("b", ["amazon.secondary"], 1), ship("c", ["etsy.listing"], 8)],
      1,
      skipped,
      (c) => isSpecSelected(channels, c),
    );
    expect(kept.map((s) => s.id)).toEqual(["a", "c"]);
    expect(skipped).toEqual([{ type: "alt_angle_white", reason: CHANNEL_NOT_SELECTED_REASON }]);
  });

  it("plans exactly one white front image for Etsy and Google together", () => {
    const list = planShots(profile(), { ...baseOpts, channels: ["etsy.listing", "google"] });
    const fronts = list.shots.filter((s) => s.priority === 1);
    expect(fronts).toHaveLength(1);
    expect(fronts[0]).toMatchObject({
      type: "alt_angle_white",
      method: "deterministic",
      scene: "front angle on white",
      channels: ["etsy.listing", "google.merchant.main"],
    });
    expect(list.shots.filter((s) => s.channels.includes("google.merchant.main"))).toEqual(fronts);
    expect(list.shots.filter((s) => s.scene === "front angle on white")).toHaveLength(1);
  });

  it("fills Google's main slot with the white front image when Google is picked alone", () => {
    const list = planShots(profile(), { ...baseOpts, channels: ["google.merchant.main"] });
    expect(list.shots).toEqual([
      expect.objectContaining({ type: "alt_angle_white", priority: 1, channels: ["google.merchant.main"] }),
    ]);
    // With Amazon picked, the Amazon main image fills it instead.
    const withAmazon = planShots(profile(), { ...baseOpts, channels: ["amazon.main", "google.merchant.main"] });
    expect(withAmazon.shots.filter((s) => s.channels.includes("google.merchant.main"))).toEqual([
      expect.objectContaining({ type: "amazon_main", channels: ["amazon.main", "google.merchant.main"] }),
    ]);
  });

  it("plans no gallery shots for a social only pack instead of a Shopify fallback", () => {
    const list = planShots(profile(), { ...baseOpts, channels: ["meta.feed_1x1"] });
    expect(list.shots.map((s) => [s.type, s.channels])).toEqual([["social_1x1", ["meta.feed_1x1"]]]);
    for (const type of ["alt_angle_white", "cutout_png", "sweep_gray", "lifestyle", "infographic"]) {
      expect(list.skipped, type).toContainEqual({ type, reason: CHANNEL_NOT_SELECTED_REASON });
    }
  });

  it("keeps a file for every picked spec at the reserved budget, however many angles were photographed", () => {
    // The reserve for the default form is the three angle product's plan.
    const reserve = Math.ceil(cost(planShots(threeAngles, { ...baseOpts, channels: DEFAULT_FORM, creditBudget: 1000 })));
    let squeezed = 0;
    for (const product of [threeAngles, fourAngles, profile({ photographedAngles: allAngles, missingAnglesNeeded: [] })]) {
      const roomy = planShots(product, { ...baseOpts, channels: DEFAULT_FORM, creditBudget: 1000 });
      const list = planShots(product, { ...baseOpts, channels: DEFAULT_FORM, creditBudget: reserve });
      expect(cost(list)).toBeLessThanOrEqual(reserve);
      for (const specId of DEFAULT_FORM) {
        expect(list.shots.some((s) => s.channels.includes(specId)), `${product.photographedAngles.length} angles ${specId}`).toBe(
          true,
        );
      }
      if (cost(roomy) > reserve) {
        // The richer product lost gallery extras, never the social crop.
        squeezed += 1;
        expect(list.skipped.some((s) => s.reason === CREDIT_BUDGET_REASON)).toBe(true);
        expect(list.skipped.some((s) => s.type === "social_1x1")).toBe(false);
      }
    }
    // Both richer products needed more than the reserve.
    expect(squeezed).toBe(2);
  });
});

describe("trimToBudget keeps a file for every picked spec it can afford", () => {
  const shot = (id: string, channels: string[], priority: number, credits = 0.5): Shot => ({
    id,
    type: "alt_angle_white",
    sourceMediaId: "m1",
    method: "deterministic",
    channels,
    stylePreset: "none",
    credits,
    priority,
  });

  it("returns a plan within budget untouched", () => {
    const shots = [shot("a", ["amazon.main"], 1), shot("b", ["meta.feed_1x1"], 7)];
    const skipped: ShotList["skipped"] = [];
    expect(trimToBudget(shots, 1, skipped)).toEqual(shots);
    expect(skipped).toEqual([]);
  });

  it("drops extras on a covered spec before the only shot on another spec, whatever its priority", () => {
    const shots = [
      shot("main", ["amazon.main"], 1),
      shot("alt1", ["amazon.secondary"], 2),
      shot("alt2", ["amazon.secondary"], 2),
      shot("alt3", ["amazon.secondary"], 3),
      shot("crop", ["meta.feed_1x1"], 7),
    ];
    const skipped: ShotList["skipped"] = [];
    const kept = trimToBudget(shots, 1.5, skipped);
    expect(kept.map((s) => s.id)).toEqual(["main", "alt1", "crop"]);
    expect(skipped).toEqual([
      { type: "alt_angle_white", reason: CREDIT_BUDGET_REASON },
      { type: "alt_angle_white", reason: CREDIT_BUDGET_REASON },
    ]);
  });

  it("lets a spec go without when its only shot does not fit, and keeps the budget for the rest", () => {
    const shots = [
      shot("main", ["amazon.main"], 1),
      shot("alt1", ["amazon.secondary"], 2),
      shot("alt2", ["amazon.secondary"], 2),
      shot("loop", ["video.social_9x16"], 9, 6),
    ];
    const kept = trimToBudget(shots, 1.5, []);
    expect(kept.map((s) => s.id)).toEqual(["main", "alt1", "alt2"]);
  });

  it("protects the best shot on each spec by priority, then the cheaper one", () => {
    const shots = [
      shot("scene", ["google.merchant.lifestyle"], 4, 1),
      shot("sweep", ["google.merchant.lifestyle"], 4, 0.5),
      shot("pin", ["pinterest.pin"], 7),
    ];
    const kept = trimToBudget(shots, 1, []);
    expect(kept.map((s) => s.id)).toEqual(["sweep", "pin"]);
  });
});

describe("planShots with output options (PHASE_15 item 3)", () => {
  const DEFAULT_CHANNELS = ["amazon.main", "amazon.secondary", "shopify.product", "meta.feed_1x1"];
  const ALL_ON: OutputExtras = { scenes: true, backdrops: true, transparentPng: true, graphics: true, cards: true };
  const ALL_OFF: OutputExtras = { scenes: false, backdrops: false, transparentPng: false, graphics: false, cards: false };
  const threePhotos: PlanPhoto[] = [
    { id: "m_front", angle: "front", width: 3000, height: 3000 },
    { id: "m_45", angle: "45", width: 3000, height: 3000 },
    { id: "m_back", angle: "back", width: 3000, height: 3000 },
  ];
  const mediaIdsByAngle = { front: "m_front", "45": "m_45", back: "m_back" };
  const product = profile({ photographedAngles: ["front", "45", "back"], missingAnglesNeeded: [] });

  function flags(
    background: "remove" | "keep",
    extras: Partial<OutputExtras> = {},
    photos: PlanPhoto[] = threePhotos,
    fit: "auto" | "pad" = "auto",
  ): OutputPlanFlags {
    return {
      background,
      keepMediaIds: background === "keep" ? photos.map((p) => p.id) : [],
      extras: { ...(background === "keep" ? ALL_OFF : ALL_ON), ...extras },
      fit,
      photos,
    };
  }
  const opts = (channels: string[], output?: OutputPlanFlags, extra: Partial<PlanOptions> = {}): PlanOptions => ({
    channels,
    tier: "starter",
    creditBudget: 100,
    primaryMediaId: "m_front",
    mediaIdsByAngle,
    hasBoxContents: true,
    hasComparisonFacts: true,
    ...(output ? { output } : {}),
    ...extra,
  });
  const originals = (list: ShotList) => list.shots.filter((s) => s.type === "original_photo");
  const sorted = (values: readonly string[]) => [...values].sort();

  it("plans Keep on the default channels as a white Amazon main plus one original per photo", () => {
    const list = planShots(product, opts(DEFAULT_CHANNELS, flags("keep")));
    expect(sorted(list.shots.map((s) => s.type))).toEqual([
      "amazon_main",
      "original_photo",
      "original_photo",
      "original_photo",
    ]);
    expect(list.shots.find((s) => s.type === "amazon_main")!.channels).toEqual(["amazon.main"]);
    const [front, ...others] = originals(list);
    expect(front).toMatchObject({
      sourceMediaId: "m_front",
      method: "deterministic",
      stylePreset: "none",
      credits: creditCosts.deterministic,
      priority: 1,
    });
    expect(sorted(front.channels)).toEqual(["amazon.secondary", "meta.feed_1x1", "shopify.product"]);
    expect(others.map((s) => s.sourceMediaId)).toEqual(["m_45", "m_back"]);
    for (const other of others) {
      expect(other.priority).toBe(2);
      expect(sorted(other.channels)).toEqual(["amazon.secondary", "shopify.product"]);
    }
    for (const type of [
      "alt_angle_white",
      "sweep_gray",
      "sweep_brand",
      "cutout_png",
      "lifestyle",
      "collection_thumb",
      "social_1x1",
    ]) {
      expect(list.shots.some((s) => s.type === type), type).toBe(false);
    }
    const off = list.skipped.filter((s) => s.reason === SELLER_OFF_REASON).map((s) => s.type);
    expect(off).toEqual(
      expect.arrayContaining(["cutout_png", "sweep_gray", "sweep_brand", "lifestyle", "infographic", "social_1x1"]),
    );
    // The originals replace collection_thumb and the white angles; neither is listed as left out.
    expect(list.skipped.some((s) => s.type === "collection_thumb" || s.type.startsWith("alt_angle_white"))).toBe(false);
    // The stored plan never carries the planner's internal skipped channels.
    expect(list.skipped.every((s) => sorted(Object.keys(s)).join() === "reason,type")).toBe(true);
  });

  it("plans the kept originals whatever usableForMain says", () => {
    const blurry = profile({
      photographedAngles: ["front", "45", "back"],
      missingAnglesNeeded: [],
      imageQuality: { usableForMain: false, issues: ["blur"] },
    });
    const list = planShots(blurry, opts(DEFAULT_CHANNELS, flags("keep")));
    expect(originals(list)).toHaveLength(3);
    expect(list.skipped).toContainEqual({ type: "amazon_main", reason: "needs photo" });
  });

  it("narrows the white front and the alternate angles to the white required specs with Keep", () => {
    const channels = [
      "amazon.main",
      "walmart.main",
      "tiktokshop.main",
      "google.merchant.main",
      "etsy.listing",
      "ebay.listing",
    ];
    const list = planShots(product, opts(channels, flags("keep")));
    const main = list.shots.find((s) => s.type === "amazon_main")!;
    expect(sorted(main.channels)).toEqual(["amazon.main", "google.merchant.main", "tiktokshop.main", "walmart.main"]);
    const angles = list.shots.filter((s) => s.type === "alt_angle_white");
    expect(angles.map((s) => s.sourceMediaId)).toEqual(["m_45", "m_back"]);
    for (const shot of angles) {
      expect(sorted(shot.channels)).toEqual(["tiktokshop.main", "walmart.main"]);
    }
    expect(originals(list)).toHaveLength(3);
    for (const shot of originals(list)) {
      expect(sorted(shot.channels)).toEqual(["ebay.listing", "etsy.listing"]);
    }
    expect(list.shots).toHaveLength(6);
  });

  it("plans the white front image only for white required specs when Amazon main is not picked", () => {
    const list = planShots(product, opts(["etsy.listing", "google.merchant.main"], flags("keep")));
    const front = list.shots.find((s) => s.type === "alt_angle_white" && s.priority === 1)!;
    expect(front.channels).toEqual(["google.merchant.main"]);
    expect(originals(list).find((s) => s.priority === 1)!.channels).toEqual(["etsy.listing"]);
    const etsyOnly = planShots(product, opts(["etsy.listing"], flags("keep")));
    expect(etsyOnly.shots.map((s) => s.type)).toEqual(["original_photo", "original_photo", "original_photo"]);
  });

  it("never aims an original at a white required spec, for every option combination", () => {
    const families = Object.keys(ALL_ON) as Array<keyof OutputExtras>;
    const channelSets = [
      DEFAULT_CHANNELS,
      ["amazon", "shopify", "google", "etsy", "ebay", "walmart", "tiktokshop", "meta", "pinterest", "video"],
      ["walmart.main", "tiktokshop.main", "google.merchant.main"],
    ];
    for (let mask = 0; mask < 1 << families.length; mask++) {
      const extras = Object.fromEntries(families.map((f, i) => [f, (mask & (1 << i)) !== 0])) as OutputExtras;
      for (const background of ["remove", "keep"] as const) {
        for (const fit of ["auto", "pad"] as const) {
          for (const channels of channelSets) {
            const list = planShots(product, opts(channels, flags(background, extras, threePhotos, fit)));
            for (const shot of originals(list)) {
              for (const specId of shot.channels) {
                expect(requiresWhiteBackground(getSpec(specId)), `${specId} ${background} ${mask}`).toBe(false);
                expect(specAcceptsImage(getSpec(specId), "original")).toBe(true);
                expect(specId.startsWith("video.")).toBe(false);
              }
            }
            if (background === "remove") {
              expect(originals(list)).toEqual([]);
            }
            expect(channelLimitViolations(list.shots)).toEqual([]);
          }
        }
      }
    }
  });

  it("removes exactly each extra family when it is off, and the family holds no slot", () => {
    const channels = ["amazon", "shopify", "google", "meta", "pinterest"];
    const all = planShots(product, opts(channels, flags("remove")));
    for (const family of Object.keys(EXTRA_FAMILIES) as Array<keyof OutputExtras>) {
      const types = EXTRA_FAMILIES[family];
      const list = planShots(product, opts(channels, flags("remove", { [family]: false })));
      expect(list.shots.filter((s) => types.includes(s.type)), family).toEqual([]);
      const rest = (l: ShotList) =>
        l.shots.filter((s) => !types.includes(s.type)).map((s) => `${s.type}:${s.sourceMediaId}`);
      expect(rest(list), family).toEqual(rest(all));
      const off = list.skipped.filter((s) => s.reason === SELLER_OFF_REASON).map((s) => s.type);
      expect(new Set(off), family).toEqual(new Set(all.shots.filter((s) => types.includes(s.type)).map((s) => s.type)));
      expect(list.skipped.some((s) => s.reason === CHANNEL_LIMIT_REASON || s.reason === CREDIT_BUDGET_REASON)).toBe(
        false,
      );
    }
  });

  it("covers a spec the seller emptied with the front image", () => {
    const list = planShots(product, opts(["amazon.main", "meta.feed_4x5"], flags("remove", { cards: false })));
    expect(list.shots.map((s) => s.type)).toEqual(["amazon_main"]);
    expect(list.shots[0].channels).toEqual(["amazon.main", "meta.feed_4x5"]);
    // With no front shot to join, one front image is added at the deterministic price.
    const alone = planShots(product, opts(["meta.feed_4x5"], flags("remove", { cards: false })));
    expect(alone.shots).toHaveLength(1);
    expect(alone.shots[0]).toMatchObject({
      type: "alt_angle_white",
      sourceMediaId: "m_front",
      channels: ["meta.feed_4x5"],
      credits: creditCosts.deterministic,
      priority: 1,
    });
    // With Keep, the front original already serves it.
    const kept = planShots(product, opts(["meta.feed_4x5"], flags("keep")));
    expect(kept.shots.map((s) => s.type)).toEqual(["original_photo"]);
    expect(kept.shots[0].channels).toEqual(["meta.feed_4x5"]);
  });

  it("never covers a spec empty for another reason", () => {
    const noFront = profile({
      photographedAngles: ["45", "back"],
      missingAnglesNeeded: [],
      imageQuality: { usableForMain: false, issues: ["blur"] },
    });
    expect(planShots(noFront, opts(["meta.feed_4x5"], flags("remove", { cards: false }))).shots).toEqual([]);
    // A spec the kept photo is too small for stays empty, even with its extras off.
    const tiny: PlanPhoto[] = [{ id: "m_front", angle: "front", width: 500, height: 500 }];
    const small = planShots(
      profile({ photographedAngles: ["front"], missingAnglesNeeded: [] }),
      opts(["amazon.secondary"], flags("keep", {}, tiny), { mediaIdsByAngle: { front: "m_front" } }),
    );
    expect(small.shots).toEqual([]);
    expect(small.skipped).toContainEqual({ type: "original_photo:amazon.secondary", reason: SOURCE_TOO_SMALL_REASON });
  });

  it("coverSellerOffSpecs never covers a white required spec and never changes its input", () => {
    const skipped: SkippedShot[] = [
      { type: "social_4x5", reason: SELLER_OFF_REASON, channels: ["meta.feed_4x5"] },
      { type: "sweep_gray", reason: SELLER_OFF_REASON, channels: ["walmart.main"] },
    ];
    const main: Shot = {
      id: "s01_amazon_main",
      type: "amazon_main",
      sourceMediaId: "m_front",
      method: "deterministic",
      channels: ["amazon.main"],
      stylePreset: "none",
      credits: creditCosts.deterministic,
      priority: 1,
    };
    const cardsOff = flags("remove", { cards: false });
    const out = coverSellerOffSpecs([main], skipped, cardsOff, { frontMediaId: "m_front", frontUsable: true });
    expect(out).toHaveLength(1);
    expect(out[0].channels).toEqual(["amazon.main", "meta.feed_4x5"]);
    expect(main.channels).toEqual(["amazon.main"]);
    const added = coverSellerOffSpecs([], skipped, cardsOff, { frontMediaId: "m_front", frontUsable: true });
    expect(added.map((s) => s.channels)).toEqual([["meta.feed_4x5"]]);
    // With Remove and no usable front photo nothing is added.
    expect(coverSellerOffSpecs([], skipped, cardsOff, { frontMediaId: "m_front", frontUsable: false })).toEqual([]);
    // Without options nothing changes.
    expect(coverSellerOffSpecs([main], skipped, undefined, { frontMediaId: "m_front", frontUsable: true })).toEqual([
      main,
    ]);
  });

  it("keeps all 6 originals on amazon.secondary with every extra on", () => {
    const angles = ["front", "45", "back", "top", "side", "detail"] as ProductProfile["photographedAngles"];
    const photos: PlanPhoto[] = angles.map((angle) => ({ id: `m_${angle}`, angle, width: 3000, height: 3000 }));
    const many = profile({ photographedAngles: angles, missingAnglesNeeded: [] });
    const list = planShots(
      many,
      opts(["amazon.main", "amazon.secondary"], flags("keep", ALL_ON, photos), {
        mediaIdsByAngle: Object.fromEntries(angles.map((a) => [a, `m_${a}`])),
      }),
    );
    const onSecondary = list.shots.filter((s) => s.channels.includes("amazon.secondary"));
    expect(onSecondary).toHaveLength(channelFileLimit(getSpec("amazon.secondary"))!);
    expect(onSecondary.filter((s) => s.type === "original_photo")).toHaveLength(6);
    expect(channelLimitViolations(list.shots)).toEqual([]);
  });

  it("leaves a kept photo off only the specs it is too small for", () => {
    const photos: PlanPhoto[] = [
      { id: "m_front", angle: "front", width: 1000, height: 800 },
      { id: "m_45", angle: "45", width: 3000, height: 3000 },
    ];
    const list = planShots(
      profile({ photographedAngles: ["front", "45"], missingAnglesNeeded: [] }),
      opts(["amazon.secondary", "etsy.listing", "meta.feed_1x1"], flags("keep", {}, photos), {
        mediaIdsByAngle: { front: "m_front", "45": "m_45" },
      }),
    );
    const front = originals(list).find((s) => s.sourceMediaId === "m_front")!;
    // 1000 px is under 1600 / MAX_SOURCE_UPSCALE, so amazon.secondary is left out.
    expect(sorted(front.channels)).toEqual(["etsy.listing", "meta.feed_1x1"]);
    expect(list.skipped).toContainEqual({ type: "original_photo:amazon.secondary", reason: SOURCE_TOO_SMALL_REASON });
    const other = originals(list).find((s) => s.sourceMediaId === "m_45")!;
    expect(sorted(other.channels)).toEqual(["amazon.secondary", "etsy.listing"]);
  });

  it("applyOriginalSizes caps the enlarge at 1 with Never enlarge my photo (P1)", () => {
    const shot: Shot = {
      id: "s01_original_photo",
      type: "original_photo",
      sourceMediaId: "m_front",
      method: "deterministic",
      channels: ["amazon.secondary", "etsy.listing"],
      stylePreset: "none",
      credits: creditCosts.deterministic,
      priority: 1,
    };
    // 1400 px reaches amazon.secondary's 1600 within 1.5, but not at 1.
    const photos = [{ id: "m_front", angle: "front", width: 1400, height: 1400 }];
    const enlarged: SkippedShot[] = [];
    expect(applyOriginalSizes([shot], flags("keep", {}, photos), enlarged)).toEqual([shot]);
    const never: SkippedShot[] = [];
    const out = applyOriginalSizes([shot], { ...flags("keep", {}, photos), enlarge: false }, never);
    expect(out.map((s) => s.channels)).toEqual([["etsy.listing"]]);
    expect(never).toContainEqual({ type: "original_photo:amazon.secondary", reason: SOURCE_TOO_SMALL_REASON });
  });

  it("applyOriginalSizes treats a photo of unknown size as fitting", () => {
    const shot: Shot = {
      id: "s01_original_photo",
      type: "original_photo",
      sourceMediaId: "m_front",
      method: "deterministic",
      channels: ["amazon.secondary"],
      stylePreset: "none",
      credits: creditCosts.deterministic,
      priority: 1,
    };
    const skipped: SkippedShot[] = [];
    expect(applyOriginalSizes([shot], flags("keep", {}, [{ id: "m_front" }]), skipped)).toEqual([shot]);
    expect(skipped).toEqual([]);
  });

  it("leaves a kept photo with added text off every spec that refuses overlays (P1)", () => {
    const photos: PlanPhoto[] = [
      { id: "m_front", angle: "front", width: 3000, height: 3000, addedOverlays: true },
      { id: "m_45", angle: "45", width: 3000, height: 3000 },
    ];
    const picked = ["amazon.secondary", "ebay.listing", "google.merchant.lifestyle", "etsy.listing"];
    const list = planShots(
      profile({ photographedAngles: ["front", "45"], missingAnglesNeeded: [] }),
      opts(picked, flags("keep", {}, photos), { mediaIdsByAngle: { front: "m_front", "45": "m_45" } }),
    );
    const front = originals(list).find((s) => s.sourceMediaId === "m_front")!;
    for (const specId of front.channels) {
      expect(refusesOverlays(getSpec(specId)), specId).toBe(false);
    }
    expect(front.channels).toEqual(expect.arrayContaining(["amazon.secondary", "etsy.listing"]));
    const leftOut = list.skipped.filter((s) => s.reason === ADDED_OVERLAYS_REASON).map((s) => s.type);
    expect(sorted(leftOut)).toEqual(["original_photo:ebay.listing", "original_photo:google.merchant.lifestyle"]);
    // The clean photo keeps the specs it would have had anyway.
    const other = originals(list).find((s) => s.sourceMediaId === "m_45")!;
    const clean = planShots(
      profile({ photographedAngles: ["front", "45"], missingAnglesNeeded: [] }),
      opts(picked, flags("keep", {}, photos.map(({ addedOverlays: _flag, ...photo }) => photo)), {
        mediaIdsByAngle: { front: "m_front", "45": "m_45" },
      }),
    );
    expect(sorted(other.channels)).toEqual(sorted(originals(clean).find((s) => s.sourceMediaId === "m_45")!.channels));
    expect(clean.skipped.some((s) => s.reason === ADDED_OVERLAYS_REASON)).toBe(false);
  });

  it("applyAddedOverlays drops an original left with no spec and never touches other shots", () => {
    const original: Shot = {
      id: "s01_original_photo",
      type: "original_photo",
      sourceMediaId: "m_front",
      method: "deterministic",
      channels: ["ebay.listing"],
      stylePreset: "none",
      credits: creditCosts.deterministic,
      priority: 1,
    };
    const white: Shot = { ...original, id: "s00_amazon_main", type: "amazon_main", channels: ["ebay.listing"] };
    const flagged = flags("keep", {}, [{ id: "m_front", addedOverlays: true }]);
    const skipped: SkippedShot[] = [];
    expect(applyAddedOverlays([white, original], flagged, skipped)).toEqual([white]);
    expect(skipped).toEqual([{ type: "original_photo:ebay.listing", reason: ADDED_OVERLAYS_REASON }]);
    // Unflagged, or no options at all: unchanged.
    const none: SkippedShot[] = [];
    expect(applyAddedOverlays([original], flags("keep", {}, [{ id: "m_front" }]), none)).toEqual([original]);
    expect(applyAddedOverlays([original], undefined, none)).toEqual([original]);
    expect(none).toEqual([]);
  });

  it("never covers a spec a flagged kept photo was left out of", () => {
    const photos: PlanPhoto[] = [{ id: "m_front", angle: "front", width: 3000, height: 3000, addedOverlays: true }];
    const list = planShots(
      profile({ photographedAngles: ["front"], missingAnglesNeeded: [] }),
      opts(["ebay.listing"], flags("keep", {}, photos), { mediaIdsByAngle: { front: "m_front" } }),
    );
    expect(list.shots.some((s) => s.channels.includes("ebay.listing"))).toBe(false);
    expect(list.skipped).toContainEqual({ type: "original_photo:ebay.listing", reason: ADDED_OVERLAYS_REASON });
  });

  it("reserves a slot per original ahead of the gallery reservations", () => {
    const original = { type: "original_photo" } as Shot;
    expect(reservedSlotsFor([original, original])).toEqual([
      { type: "original_photo", count: 2 },
      ...RESERVED_GALLERY_SLOTS,
    ]);
    expect(reservedSlotsFor([])).toEqual(RESERVED_GALLERY_SLOTS);
  });

  it("skipSellerOffShots filters a plan it did not make and records the specs", () => {
    const social: Shot = {
      id: "x1",
      type: "social_1x1",
      sourceMediaId: "m_front",
      method: "template",
      channels: ["meta.feed_1x1"],
      stylePreset: "none",
      credits: creditCosts.deterministic,
      priority: 7,
    };
    const skipped: SkippedShot[] = [];
    expect(skipSellerOffShots([social], flags("remove", { cards: false }), skipped)).toEqual([]);
    expect(skipped).toEqual([{ type: "social_1x1", reason: SELLER_OFF_REASON, channels: ["meta.feed_1x1"] }]);
    expect(skipSellerOffShots([social], undefined, skipped)).toEqual([social]);
  });

  it("uses reason strings the skipped copy does not already match", () => {
    const keywords = [
      "needs photo",
      "plan tier",
      "pro or agency",
      "provider not enabled",
      "concept mode",
      "shot cap",
      "credit budget",
      "channel image limit",
      "benefits",
      "dimensions",
      "contents",
      "comparison",
    ];
    for (const reason of [SELLER_OFF_REASON, SOURCE_TOO_SMALL_REASON]) {
      for (const keyword of keywords) {
        expect(reason.toLowerCase().includes(keyword), `${reason} ${keyword}`).toBe(false);
      }
    }
  });
});
