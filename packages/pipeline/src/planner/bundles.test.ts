/**
 * Pack bundles in the deterministic planner (docs/phases/PHASE_16.md
 * workstream 1): a snapshot per bundle, the everything bundle planning
 * exactly today's default pack, BUNDLE_OFF_REASON entries before the channel
 * limits, and the same filter for plans the planner did not make.
 */
import { describe, expect, it } from "vitest";
import { listSpecs } from "@curvi/specs";
import {
  BUNDLE_KEYS,
  BUNDLE_OFF_REASON,
  DEFAULT_OUTPUT_OPTIONS,
  SELLER_OFF_REASON,
  bundleShotTypes,
  isSecondaryShot,
  normalizeOutputOptions,
  planFlagsOf,
  resolveOutputOptions,
  type BundleKey,
  type OutputOptionsInput,
  type OutputPlanFlags,
} from "../output-options";
import type { ProductProfile, Shot } from "../schemas";
import {
  CHANNEL_NOT_SELECTED_REASON,
  NO_COMPATIBLE_CHANNEL_REASON,
  UNDELIVERABLE_METHOD_REASON,
  bundleOffShotTypes,
  coverSellerOffSpecs,
  planShots,
  skipBundleOffShots,
  skipSellerOffShots,
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
    preserveText: [],
    preserveLogos: [],
    surface: { reflective: false, transparent: false, textured: false },
    features: ["pour over rim"],
    benefits: ["keeps coffee hot", "easy grip handle", "fits any dripper"],
    targetBuyer: "home coffee drinkers",
    useContexts: ["morning kitchen counter", "office desk"],
    photographedAngles: ["front", "45", "back"],
    missingAnglesNeeded: ["side"],
    complianceFlags: ["none"],
    imageQuality: { usableForMain: true, issues: [] },
    ...overrides,
  };
}

const families = [...new Set(listSpecs().map((spec) => spec.id.split(".")[0]))];

/** The form's default pick, every family alone and everything. */
const CHANNEL_PRESETS: ReadonlyArray<readonly string[]> = [
  ["amazon.main", "amazon.secondary", "shopify.product", "meta.feed_1x1"],
  ...families.map((family) => [family]),
  families,
];

const PHOTOS = [
  { id: "m_front", angle: "front", width: 3000, height: 3000 },
  { id: "m_45", angle: "45", width: 3000, height: 3000 },
  { id: "m_back", angle: "back" },
  { id: "m_pack", angle: "packaging", width: 400, height: 300 },
];

function flagsFor(input: OutputOptionsInput, keep: string[] = []): OutputPlanFlags {
  const resolved = resolveOutputOptions(normalizeOutputOptions(input), {
    colorHex: "#FFFFFF",
    brandSweepHex: "#FFFFFF",
    keepMediaIds: keep,
  });
  return planFlagsOf(resolved, PHOTOS);
}

function planOne(channels: readonly string[], extra: Partial<PlanOptions> = {}) {
  return planShots(profile(), {
    channels: [...channels],
    tier: "growth",
    creditBudget: 100,
    primaryMediaId: "m_front",
    mediaIdsByAngle: { front: "m_front", "45": "m_45", back: "m_back", packaging: "m_pack" },
    hasBoxContents: true,
    ...extra,
  });
}

function planPresets(extra: Partial<PlanOptions> = {}) {
  return CHANNEL_PRESETS.map((channels) => ({ channels: channels.join(","), plan: planOne(channels, extra) }));
}

describe("planner bundles", () => {
  for (const bundle of BUNDLE_KEYS) {
    it(`plans the ${bundle} bundle for every channel preset`, () => {
      expect(planPresets({ output: flagsFor({ bundle }) })).toMatchSnapshot();
    });
  }

  it("plans exactly today's default pack with the everything bundle", () => {
    const today = planPresets();
    expect(planPresets({ output: flagsFor({ bundle: "everything" }) })).toEqual(today);
    const resolved = resolveOutputOptions(DEFAULT_OUTPUT_OPTIONS, {
      colorHex: "#FFFFFF",
      brandSweepHex: "#FFFFFF",
      keepMediaIds: [],
    });
    expect(planPresets({ output: planFlagsOf(resolved, PHOTOS) })).toEqual(today);
  });

  it("only plans shot types inside the bundle, and records the rest as not in the chosen set", () => {
    for (const bundle of BUNDLE_KEYS) {
      const types = bundleShotTypes(bundle);
      for (const { plan } of planPresets({ output: flagsFor({ bundle }) })) {
        for (const shot of plan.shots) {
          expect(types.has(shot.type), `${bundle} ${shot.type}`).toBe(true);
        }
        for (const entry of plan.skipped) {
          if (!types.has(entry.type.split(":")[0] as Shot["type"])) {
            expect([BUNDLE_OFF_REASON, UNDELIVERABLE_METHOD_REASON, CHANNEL_NOT_SELECTED_REASON, NO_COMPATIBLE_CHANNEL_REASON]).toContain(entry.reason);
          }
        }
      }
    }
  });

  it("makes one main image per marketplace with the main set, never another angle", () => {
    const plan = planOne(families, { output: flagsFor({ bundle: "main" }) });
    expect(plan.shots.filter((shot) => isSecondaryShot(shot))).toEqual([]);
    expect(plan.shots.map((shot) => shot.type).sort()).toEqual(["amazon_main", "collection_thumb"]);
    const noAmazon = planOne(["etsy", "shopify"], { output: flagsFor({ bundle: "main" }) });
    expect(noAmazon.shots.map((shot) => [shot.type, shot.priority])).toEqual([
      ["alt_angle_white", 1],
      ["collection_thumb", 6],
    ]);
    expect(plan.skipped).toContainEqual({ type: "alt_angle_white", reason: BUNDLE_OFF_REASON });
    expect(plan.skipped).toContainEqual({ type: "lifestyle", reason: BUNDLE_OFF_REASON });
    expect(plan.skipped.filter((entry) => entry.reason === SELLER_OFF_REASON)).toEqual([]);
  });

  it("keeps a kept front photo and drops other kept photos with the main set", () => {
    const plan = planOne(["amazon.secondary", "shopify.product"], {
      output: flagsFor({ bundle: "main", background: "keep" }, ["m_front", "m_45"]),
    });
    const originals = plan.shots.filter((shot) => shot.type === "original_photo");
    expect(originals.map((shot) => shot.sourceMediaId)).toEqual(["m_front"]);
    expect(plan.skipped).toContainEqual({ type: "original_photo", reason: BUNDLE_OFF_REASON });
  });

  it("makes the A+ banners and the main image with the A+ set, and no social card", () => {
    const plan = planOne(["amazon", "meta"], { output: flagsFor({ bundle: "aplus" }) });
    const types = new Set(plan.shots.map((shot) => shot.type));
    expect(types.has("aplus_banner")).toBe(true);
    expect(types.has("amazon_main")).toBe(true);
    expect([...types].some((type) => type.startsWith("social_"))).toBe(false);
    expect(plan.shots.some((shot) => shot.channels.some((c) => c.startsWith("meta.")))).toBe(false);
  });

  it("never fills a spec the bundle emptied with the front image", () => {
    const plan = planOne(["meta.feed_4x5"], { output: flagsFor({ bundle: "listing" }) });
    expect(plan.shots).toEqual([]);
    expect(plan.skipped).toContainEqual({ type: "social_4x5", reason: BUNDLE_OFF_REASON });
  });

  it("still covers a spec the seller emptied inside the everything bundle", () => {
    const plan = planOne(["meta.feed_4x5"], { output: flagsFor({ extras: { cards: false } }) });
    expect(plan.shots.map((shot) => shot.type)).toEqual(["alt_angle_white"]);
  });

  it("skips a missing angle as not in the set when the set takes no other angle", () => {
    const plan = planOne(["amazon"], { output: flagsFor({ bundle: "main" }) });
    expect(plan.skipped).toContainEqual({ type: "alt_angle_white:side", reason: BUNDLE_OFF_REASON });
    const today = planOne(["amazon"]);
    expect(today.skipped).toContainEqual({ type: "alt_angle_white:side", reason: "needs photo" });
  });
});

describe("skipBundleOffShots for plans the planner did not make", () => {
  const shot = (id: string, type: Shot["type"], priority: number, channels = ["amazon.secondary"]): Shot => ({
    id,
    type,
    sourceMediaId: "m_front",
    method: "deterministic",
    channels,
    stylePreset: "none",
    credits: 0.5,
    priority,
  });
  const llmPlan: Shot[] = [
    shot("a", "amazon_main", 1, ["amazon.main"]),
    shot("b", "alt_angle_white", 2),
    shot("c", "lifestyle", 4),
    shot("d", "social_1x1", 7, ["meta.feed_1x1"]),
    shot("e", "alt_angle_white", 2),
  ];

  it("is a no op for today's pack", () => {
    const skipped: SkippedShot[] = [];
    expect(skipBundleOffShots(llmPlan, undefined, skipped)).toEqual(llmPlan);
    expect(skipBundleOffShots(llmPlan, { bundle: "everything" }, skipped)).toEqual(llmPlan);
    expect(skipped).toEqual([]);
    expect(bundleOffShotTypes(undefined).size).toBe(0);
  });

  it("drops types outside the set and other angles past the cap, with their specs", () => {
    const skipped: SkippedShot[] = [];
    expect(skipBundleOffShots(llmPlan, { bundle: "main" }, skipped).map((s) => s.id)).toEqual(["a"]);
    expect(skipped).toEqual([
      { type: "alt_angle_white", reason: BUNDLE_OFF_REASON, channels: ["amazon.secondary"] },
      { type: "lifestyle", reason: BUNDLE_OFF_REASON, channels: ["amazon.secondary"] },
      { type: "social_1x1", reason: BUNDLE_OFF_REASON, channels: ["meta.feed_1x1"] },
      { type: "alt_angle_white", reason: BUNDLE_OFF_REASON, channels: ["amazon.secondary"] },
    ]);
  });

  it("runs first inside skipSellerOffShots, so the runner's fit applies it", () => {
    const flags = flagsFor({ bundle: "listing" });
    const skipped: SkippedShot[] = [];
    const kept = skipSellerOffShots(llmPlan, flags, skipped);
    expect(kept.map((s) => s.id)).toEqual(["a", "b", "c", "e"]);
    expect(skipped).toEqual([{ type: "social_1x1", reason: BUNDLE_OFF_REASON, channels: ["meta.feed_1x1"] }]);
    // Seller off cover leaves the spec the bundle emptied alone.
    const covered = coverSellerOffSpecs(kept, skipped, flags, { frontMediaId: "m_front", frontUsable: true });
    expect(covered.some((s) => s.channels.includes("meta.feed_1x1"))).toBe(false);
  });

  it("agrees with the planner on which types each bundle leaves out", () => {
    for (const bundle of BUNDLE_KEYS as readonly BundleKey[]) {
      const off = bundleOffShotTypes({ bundle });
      for (const type of bundleShotTypes(bundle)) {
        expect(off.has(type)).toBe(false);
      }
    }
  });
});
