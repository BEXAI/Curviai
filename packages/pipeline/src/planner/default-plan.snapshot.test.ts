/**
 * PHASE_15 guard: with no output options, and with the default options
 * (Marketplace ready), the deterministic planner plans exactly the shots it
 * planned before seller controls existed, for every channel preset. The
 * snapshot was captured on the pre PHASE_15 planner and must not change.
 */
import { describe, expect, it } from "vitest";
import { listSpecs } from "@curvi/specs";
import { DEFAULT_OUTPUT_OPTIONS, planFlagsOf, resolveOutputOptions } from "../output-options";
import type { ProductProfile } from "../schemas";
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

/** The new pack form's default pick, every family alone, every spec alone and everything. */
const CHANNEL_PRESETS: ReadonlyArray<readonly string[]> = [
  ["amazon.main", "amazon.secondary", "shopify.product", "meta.feed_1x1"],
  ...families.map((family) => [family]),
  ...listSpecs().map((spec) => [spec.id]),
  families,
];

const PROFILES: Record<string, ProductProfile> = {
  reference: profile(),
  manyAngles: profile({
    photographedAngles: ["front", "45", "back", "top", "side", "packaging"],
    missingAnglesNeeded: [],
  }),
  noFront: profile({ photographedAngles: ["45", "back"], imageQuality: { usableForMain: false, issues: ["blur"] } }),
};

/** Plans every preset for one product; `extra` adds plan options. */
function planPresets(product: ProductProfile, extra: Partial<PlanOptions> = {}) {
  return CHANNEL_PRESETS.map((channels) => ({
    channels: channels.join(","),
    plan: planShots(product, {
      channels: [...channels],
      tier: "growth",
      creditBudget: 100,
      primaryMediaId: "m_front",
      mediaIdsByAngle: { front: "m_front", "45": "m_45", back: "m_back", packaging: "m_pack" },
      hasBoxContents: true,
      ...extra,
    }),
  }));
}

describe("default plan snapshot", () => {
  for (const [name, product] of Object.entries(PROFILES)) {
    it(`plans today's shots for every channel preset: ${name}`, () => {
      expect(planPresets(product)).toMatchSnapshot();
    });

    it(`plans the same shots with the default options: ${name}`, () => {
      const resolved = resolveOutputOptions(DEFAULT_OUTPUT_OPTIONS, {
        colorHex: "#FFFFFF",
        brandSweepHex: "#FFFFFF",
        keepMediaIds: [],
      });
      const photos = [
        { id: "m_front", angle: "front", width: 3000, height: 3000 },
        { id: "m_45", angle: "45", width: 3000, height: 3000 },
        { id: "m_back", angle: "back" },
        { id: "m_pack", angle: "packaging", width: 400, height: 300 },
      ];
      expect(planPresets(product, { output: planFlagsOf(resolved, photos) })).toEqual(planPresets(product));
    });
  }
});
