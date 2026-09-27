import { describe, expect, it } from "vitest";
import { ShotList, type ProductProfile } from "../schemas";
import { planShots } from "./deterministic";

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
