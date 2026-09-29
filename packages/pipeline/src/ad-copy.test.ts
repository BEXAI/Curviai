/**
 * Ad copy from the copy recipe (docs/phases/PHASE_16.md workstream 3): the
 * version 3 request, its strict schema, and applyAdCopy, which rewords the
 * planned ad variants without changing the plan, the estimate or the hold.
 */
import { describe, expect, it } from "vitest";
import { PackCopyResult, adCopyRequest, adHeadlineLimit, applyAdCopy, needsAdCopy, packCopyRequest } from "./ad-copy";
import { rule9Problems } from "./copy-lint";
import { normalizeOutputOptions, planFlagsOf, resolveOutputOptions } from "./output-options";
import { planShots } from "./planner/deterministic";
import { strictToolSchema, type ProductProfile, type Shot } from "./schemas";
import { adsFormats } from "./seed/templates";

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
    dimensions: null,
    preserveText: [],
    preserveLogos: [],
    surface: { reflective: false, transparent: false, textured: false },
    features: ["pour over rim", "matte glaze"],
    benefits: ["keeps coffee hot", "easy grip handle", "fits any dripper"],
    targetBuyer: "home coffee drinkers",
    useContexts: ["morning kitchen counter"],
    photographedAngles: ["front"],
    missingAnglesNeeded: [],
    complianceFlags: ["none"],
    imageQuality: { usableForMain: true, issues: [] },
    ...overrides,
  };
}

function adsPlan(channels = ["meta", "pinterest", "tiktok"]) {
  const normalized = normalizeOutputOptions({
    extras: { ads: true, scenes: false },
  });
  const resolved = resolveOutputOptions(normalized, {
    colorHex: "#FFFFFF",
    brandSweepHex: "#3A4556",
    keepMediaIds: [],
  });
  const output = planFlagsOf(resolved, [{ id: "m_front", angle: "front", width: 3000, height: 3000 }]);
  return planShots(profile(), {
    channels,
    tier: "growth",
    creditBudget: 200,
    primaryMediaId: "m_front",
    mediaIdsByAngle: { front: "m_front" },
    output,
  });
}

const variantsOf = (shots: readonly Shot[]) => shots.filter((s) => s.type === "ad_variant");

const RECIPE_HEADLINES = [
  "Coffee stays warm longer",
  "A handle that sits right",
  "Made for slow mornings",
  "Fits the dripper you own",
  "Matte glaze, easy clean",
  "Pour over made simple",
  "One more spare line here",
];
const RECIPE_CTAS = ["Shop the mug", "See it up close", "Bring one home"];

describe("the version 3 request and answer", () => {
  it("asks for one headline and call to action per planned variant at the tightest placement limit", () => {
    const list = adsPlan();
    const variants = variantsOf(list.shots);
    expect(variants.length).toBeGreaterThanOrEqual(adsFormats.adPack.minVariants);
    expect(needsAdCopy(list.shots)).toBe(true);
    const request = adCopyRequest(list.shots)!;
    expect(request).toEqual({
      variants: variants.length,
      headlineMaxChars: Math.min(...variants.map(adHeadlineLimit)),
      callsToAction: variants.length,
      ctaMaxChars: adsFormats.adCopy.ctaMaxChars,
    });
    expect(request.headlineMaxChars).toBeLessThanOrEqual(adsFormats.lineMaxChars);
  });

  it("sends no ads section without ad variants, and keeps the module request as version 2", () => {
    const shots = adsPlan(["amazon"]).shots;
    expect(needsAdCopy(shots)).toBe(false);
    expect(adCopyRequest(shots)).toBeNull();
    const request = packCopyRequest(profile(), shots, null);
    expect(request.ads).toBeNull();
    expect(request.product.name).toBe("Ceramic pour over mug");
    expect(request.userDescription).toBeNull();
  });

  it("makes every field required in the strict schema", () => {
    const schema = strictToolSchema(PackCopyResult) as {
      required: string[];
      properties: {
        ads: { required: string[]; additionalProperties: boolean };
      };
    };
    expect(schema.required.sort()).toEqual(["ads", "modules"]);
    expect(schema.properties.ads.required.sort()).toEqual(["callsToAction", "headlines"]);
    expect(schema.properties.ads.additionalProperties).toBe(false);
  });
});

describe("applyAdCopy", () => {
  const ctx = { sellerText: [] as string[] };

  it("rewords the variants and leaves the plan, channels, credits and order alone", () => {
    const list = adsPlan();
    const out = applyAdCopy(list.shots, { ads: { headlines: RECIPE_HEADLINES, callsToAction: RECIPE_CTAS } }, ctx);
    expect(out.map((s) => [s.id, s.type, s.channels, s.credits, s.variantKey])).toEqual(
      list.shots.map((s) => [s.id, s.type, s.channels, s.credits, s.variantKey]),
    );
    expect(out.filter((s) => s.type !== "ad_variant")).toEqual(list.shots.filter((s) => s.type !== "ad_variant"));
    const variants = variantsOf(out);
    const headlines = variants.map((v) => v.headline!);
    expect(new Set(headlines).size).toBe(headlines.length);
    for (const variant of variants) {
      expect(RECIPE_HEADLINES).toContain(variant.headline);
      expect(variant.headline!.length).toBeLessThanOrEqual(adHeadlineLimit(variant));
      expect(RECIPE_CTAS).toContain(variant.cta);
      expect(rule9Problems(variant.headline!)).toEqual([]);
      expect(rule9Problems(variant.cta!)).toEqual([]);
    }
    expect(variants[0]!.cta).toBe(RECIPE_CTAS[0]);
    expect(variants[1]!.cta).toBe(RECIPE_CTAS[1]);
  });

  it("drops recipe lines with a figure or claim word the seller did not type, and dashes are linted", () => {
    const list = adsPlan();
    const n = variantsOf(list.shots).length;
    const bad = ["Keeps coffee hot 6 hours", "Clinically proven warmth", "Best mug ever!!"];
    const out = applyAdCopy(
      list.shots,
      {
        ads: {
          headlines: [...bad, ...RECIPE_HEADLINES.slice(0, n)],
          callsToAction: RECIPE_CTAS,
        },
      },
      ctx,
    );
    for (const variant of variantsOf(out)) {
      expect(variant.headline).not.toMatch(/\d|proven|best/i);
    }
    // The seller typed the figure: then it may print.
    const typed = applyAdCopy(
      list.shots,
      {
        ads: {
          headlines: ["Keeps coffee hot 6 hours", ...RECIPE_HEADLINES],
          callsToAction: RECIPE_CTAS,
        },
      },
      { sellerText: ["keeps it hot for 6 hours"] },
    );
    expect(variantsOf(typed)[0]!.headline).toBe("Keeps coffee hot 6 hours");
  });

  it("keeps every planner headline when the recipe gives too few clean ones, never mixing sources", () => {
    const list = adsPlan();
    const n = variantsOf(list.shots).length;
    const out = applyAdCopy(
      list.shots,
      {
        ads: { headlines: RECIPE_HEADLINES.slice(0, n - 1), callsToAction: [] },
      },
      ctx,
    );
    expect(variantsOf(out).map((v) => [v.headline, v.cta])).toEqual(
      variantsOf(list.shots).map((v) => [v.headline, v.cta]),
    );
  });

  it("keeps the seed calls to action below the seeded minimum of clean recipe ones", () => {
    const list = adsPlan();
    const out = applyAdCopy(
      list.shots,
      {
        ads: {
          headlines: RECIPE_HEADLINES,
          callsToAction: ["Buy now 50 percent off", "Shop the mug"],
        },
      },
      ctx,
    );
    expect(variantsOf(out).map((v) => v.cta)).toEqual(variantsOf(list.shots).map((v) => v.cta));
  });

  it("skips a headline too long for a variant's tightest placement", () => {
    const list = adsPlan(["meta"]);
    const variants = variantsOf(list.shots);
    const limit = Math.min(...variants.map(adHeadlineLimit));
    const long = "Warm coffee in a good mug every single day".slice(0, limit + 4).trim();
    expect(long.length).toBeGreaterThan(limit);
    expect(long.length).toBeLessThanOrEqual(adsFormats.lineMaxChars);
    const out = applyAdCopy(
      list.shots,
      {
        ads: {
          headlines: [long, ...RECIPE_HEADLINES],
          callsToAction: RECIPE_CTAS,
        },
      },
      ctx,
    );
    expect(variantsOf(out).map((v) => v.headline)).not.toContain(long);
  });

  it("changes nothing without an answer or without ad variants", () => {
    const list = adsPlan();
    expect(applyAdCopy(list.shots, null, ctx)).toEqual(list.shots);
    const amazon = adsPlan(["amazon"]).shots;
    expect(applyAdCopy(amazon, { ads: { headlines: RECIPE_HEADLINES, callsToAction: RECIPE_CTAS } }, ctx)).toEqual(
      amazon,
    );
  });
});
