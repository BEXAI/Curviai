/**
 * Scene variations (docs/phases/PHASE_16.md workstream 6, founder decision
 * 3): the option, the plan marks, the run time expansion and the price.
 * Every extra version costs exactly creditCosts.generativeStill (the seed),
 * the first is the scene at its normal price, and a pack at the default of
 * one plans exactly today's pack.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUTPUT_OPTIONS,
  DEFAULT_VARIATIONS,
  lookOf,
  normalizeOutputOptions,
  outputOptionsKey,
  planFlagsOf,
  resolveOutputOptions,
  variationsOf,
  type OutputOptionsInput,
} from "./output-options";
import { planShots } from "./planner/deterministic";
import { LlmShot, Shot, type ProductProfile } from "./schemas";
import { creditCosts, variationOptions } from "./seed";
import {
  applyVariations,
  expandVariations,
  extraVariationCredits,
  isExtraVariation,
  parseVariationShotId,
  variationShotId,
} from "./variations";

function profile(): ProductProfile {
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
    features: ["pour over rim"],
    benefits: ["keeps coffee hot", "easy grip handle"],
    targetBuyer: "home coffee drinkers",
    useContexts: ["morning kitchen counter", "office desk"],
    photographedAngles: ["front", "45", "back"],
    missingAnglesNeeded: [],
    complianceFlags: ["none"],
    imageQuality: { usableForMain: true, issues: [] },
  };
}

function flagsFor(input: OutputOptionsInput) {
  const resolved = resolveOutputOptions(normalizeOutputOptions(input), {
    colorHex: "#FFFFFF",
    brandSweepHex: "#FFFFFF",
    keepMediaIds: [],
  });
  return planFlagsOf(resolved, [{ id: "m_front", angle: "front", width: 3000, height: 3000 }]);
}

function plan(input: OutputOptionsInput, budget = 1000) {
  return planShots(profile(), {
    channels: ["amazon.main", "amazon.secondary", "shopify.product", "meta.feed_1x1"],
    tier: "growth",
    creditBudget: budget,
    primaryMediaId: "m_front",
    output: flagsFor(input),
  });
}

const lifestyle: Shot = {
  id: "s07_lifestyle",
  type: "lifestyle",
  sourceMediaId: "m_front",
  method: "composite_generate",
  channels: ["amazon.secondary", "shopify.product"],
  stylePreset: "kitchen_lifestyle",
  scene: "morning kitchen counter",
  credits: creditCosts.generativeStill,
  priority: 4,
};

const white: Shot = {
  id: "s01_amazon_main",
  type: "amazon_main",
  sourceMediaId: "m_front",
  method: "deterministic",
  channels: ["amazon.main"],
  stylePreset: "none",
  credits: creditCosts.deterministic,
  priority: 1,
};

describe("the variations option", () => {
  it("defaults to one version, from the seed, and leaves the key out", () => {
    expect(DEFAULT_VARIATIONS).toBe(variationOptions.default);
    expect(variationOptions.default).toBe(1);
    expect(variationOptions.max).toBe(4);
    expect(DEFAULT_OUTPUT_OPTIONS.variations).toBeUndefined();
    expect(normalizeOutputOptions({ variations: 1 })).toEqual(DEFAULT_OUTPUT_OPTIONS);
    expect(outputOptionsKey({ variations: 1 })).toBe(outputOptionsKey(null));
  });

  it("keeps a count past the default and changes the idempotency key", () => {
    const normalized = normalizeOutputOptions({ variations: 3 });
    expect(normalized.variations).toBe(3);
    expect(variationsOf(normalized)).toBe(3);
    expect(outputOptionsKey({ variations: 3 })).not.toBe(outputOptionsKey(null));
  });

  it("refuses a count outside the seed range", () => {
    expect(() => normalizeOutputOptions({ variations: 0 })).toThrow();
    expect(() => normalizeOutputOptions({ variations: variationOptions.max + 1 })).toThrow();
    expect(() => normalizeOutputOptions({ variations: 2.5 })).toThrow();
  });

  it("never turns a look into custom, like the bundle", () => {
    expect(lookOf(normalizeOutputOptions({ variations: 4 }))).toBe("marketplace");
  });

  it("rides through the resolved options into the plan flags", () => {
    expect(flagsFor({ variations: 2 }).variations).toBe(2);
    expect(flagsFor({}).variations).toBeUndefined();
  });

  it("is never part of the shot planner's schema", () => {
    expect(LlmShot.shape).not.toHaveProperty("variations");
    expect(LlmShot.shape).not.toHaveProperty("variation");
  });
});

describe("applyVariations", () => {
  it("leaves a pack at the default untouched", () => {
    expect(applyVariations([lifestyle, white], {})).toEqual([lifestyle, white]);
    expect(applyVariations([lifestyle, white], null)).toEqual([lifestyle, white]);
  });

  it("marks lifestyle scenes only and prices every extra version at generativeStill", () => {
    const [scene, main] = applyVariations([lifestyle, white], { variations: 3 });
    expect(scene.variations).toBe(3);
    expect(scene.credits).toBe(creditCosts.generativeStill + 2 * creditCosts.generativeStill);
    expect(scene.channels).toEqual(lifestyle.channels);
    expect(main).toEqual(white);
    expect(extraVariationCredits(4)).toBe(3 * creditCosts.generativeStill);
    expect(extraVariationCredits(1)).toBe(0);
  });

  it("is idempotent", () => {
    const once = applyVariations([lifestyle], { variations: 4 });
    expect(applyVariations(once, { variations: 4 })).toEqual(once);
  });
});

describe("expandVariations", () => {
  it("runs a marked scene as itself plus one shot per extra version, with the same total", () => {
    const marked = applyVariations([lifestyle, white], { variations: 3 });
    const run = expandVariations(marked);
    expect(run.map((s) => s.id)).toEqual([
      "s07_lifestyle",
      variationShotId("s07_lifestyle", 2),
      variationShotId("s07_lifestyle", 3),
      "s01_amazon_main",
    ]);
    const total = (shots: Shot[]) => shots.reduce((sum, s) => sum + s.credits, 0);
    expect(total(run)).toBe(total(marked));
    const [scene, v2, v3] = run;
    expect(scene).toEqual(lifestyle);
    expect(isExtraVariation(scene)).toBe(false);
    for (const [shot, n] of [
      [v2, 2],
      [v3, 3],
    ] as const) {
      expect(isExtraVariation(shot)).toBe(true);
      expect(shot.variation).toBe(n);
      expect(shot.credits).toBe(creditCosts.generativeStill);
      // The same real product through the same composite path (rule 3).
      expect(shot.method).toBe("composite_generate");
      expect(shot.sourceMediaId).toBe(lifestyle.sourceMediaId);
      expect(shot.scene).toBe(lifestyle.scene);
      expect(shot.channels).toEqual(lifestyle.channels);
      expect(Shot.safeParse(shot).success).toBe(true);
    }
  });

  it("passes unmarked shots through", () => {
    expect(expandVariations([lifestyle, white])).toEqual([lifestyle, white]);
  });

  it("reads a version's shot id back", () => {
    expect(parseVariationShotId("s07_lifestyle.v2")).toEqual({ baseShotId: "s07_lifestyle", variation: 2 });
    expect(parseVariationShotId("s07_lifestyle")).toBeNull();
    expect(parseVariationShotId("s07_lifestyle.v1")).toBeNull();
    expect(parseVariationShotId(`s07_lifestyle.v${variationOptions.max + 1}`)).toBeNull();
  });
});

describe("planShots with variations", () => {
  it("plans exactly today's pack at the default", () => {
    expect(plan({ variations: 1 })).toEqual(plan({}));
  });

  it("marks every scene, adds only the extra versions' price and takes no extra slot", () => {
    const base = plan({});
    const four = plan({ variations: 4 });
    expect(four.shots.map((s) => [s.id, s.channels])).toEqual(base.shots.map((s) => [s.id, s.channels]));
    const scenes = four.shots.filter((s) => s.type === "lifestyle");
    expect(scenes.length).toBeGreaterThan(0);
    for (const scene of scenes) {
      expect(scene.variations).toBe(4);
    }
    const total = (shots: Shot[]) => shots.reduce((sum, s) => sum + s.credits, 0);
    expect(total(four.shots) - total(base.shots)).toBe(scenes.length * 3 * creditCosts.generativeStill);
  });

  it("never marks a scene when scenes are off", () => {
    const off = plan({ variations: 3, extras: { scenes: false } });
    expect(off.shots.some((s) => s.variations !== undefined)).toBe(false);
  });
});
