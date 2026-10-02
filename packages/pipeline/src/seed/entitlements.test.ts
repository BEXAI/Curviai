import { describe, expect, it } from "vitest";
import {
  canUse,
  channelFamilyFeatures,
  entitlementsFor,
  featureStatus,
  includesWithStatus,
  isEntitled,
  isShotMethodDeliverable,
  lowestTierWith,
  platformSettingSeedRows,
  shotMethodFeatures,
  tierByKey,
  tierEntitlements,
  tiers,
  undeliverableShotMethods,
  type TierFeature,
  type TierKey,
} from "./credits";
import { planShots } from "../planner/deterministic";
import type { ProductProfile } from "../schemas";

const TIER_ORDER: TierKey[] = ["free", "starter", "growth", "pro", "agency"];

describe("tier entitlements (plan 9.1)", () => {
  it("covers every tier", () => {
    expect(Object.keys(tierEntitlements).sort()).toEqual([...TIER_ORDER].sort());
  });

  it("matches the entitlement matrix", () => {
    const matrix: Record<TierFeature, TierKey> = {
      sharePage: "free",
      brandKit: "starter",
      templatedVideo: "starter",
      generativeVideo: "growth",
      freshDrop: "growth",
      shopifyAutoPacks: "growth",
      lifestyleVideo: "pro",
      ugcAds: "pro",
      multipleBrandKits: "pro",
      priorityQueue: "pro",
      clientWorkspaces: "agency",
      clientReviewLinks: "agency",
      whiteLabelShare: "agency",
      apiAccess: "growth",
      assistantAccess: "free",
    };
    for (const [feature, firstTier] of Object.entries(matrix) as Array<[TierFeature, TierKey]>) {
      const first = TIER_ORDER.indexOf(firstTier);
      TIER_ORDER.forEach((tier, index) => {
        expect(isEntitled(tier, feature), `${tier} ${feature}`).toBe(index >= first);
      });
      expect(lowestTierWith(feature)?.key).toBe(firstTier);
    }
  });

  it("builds each tier on the one below", () => {
    for (let i = 1; i < TIER_ORDER.length; i++) {
      const below = entitlementsFor(TIER_ORDER[i - 1]);
      const tier = entitlementsFor(TIER_ORDER[i]);
      for (const feature of below.features) {
        expect(tier.features, `${TIER_ORDER[i]} keeps ${feature}`).toContain(feature);
      }
      expect(tier.brandKits).toBeGreaterThanOrEqual(below.brandKits);
    }
  });

  it("lets every tier use Curvi from an assistant while API keys stay Growth and up (PHASE_19 decision 3)", () => {
    expect(featureStatus.assistantAccess).toBe("live");
    for (const tier of TIER_ORDER) {
      expect(canUse(tier, "assistantAccess"), tier).toBe(true);
      expect(canUse(tier, "apiAccess"), tier).toBe(TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf("growth"));
    }
  });

  it("carries the plan's brand kit and client workspace counts", () => {
    expect(entitlementsFor("starter").brandKits).toBe(1);
    expect(entitlementsFor("pro").brandKits).toBe(3);
    expect(entitlementsFor("agency").clientWorkspaces).toBe(10);
    expect(entitlementsFor("growth").clientWorkspaces).toBe(0);
  });

  it("never lets a coming soon feature be used, however high the tier", () => {
    for (const [feature, status] of Object.entries(featureStatus) as Array<[TierFeature, string]>) {
      if (status === "coming_soon") {
        expect(canUse("agency", feature), feature).toBe(false);
      }
    }
    expect(canUse("starter", "brandKit")).toBe(true);
    expect(canUse("free", "brandKit")).toBe(false);
  });

  it("ties every includes line to a feature status, in the order the tier lists them", () => {
    for (const tier of tiers) {
      const lines = includesWithStatus(tier.key);
      expect(lines.map((l) => l.label)).toEqual(tier.includes);
      for (const line of lines) {
        expect(line.status).toBe(line.feature ? featureStatus[line.feature] : "live");
        if (line.feature) {
          expect(isEntitled(tier.key, line.feature), `${tier.key} sells ${line.feature}`).toBe(true);
        }
      }
    }
    const growth = includesWithStatus("growth");
    expect(growth.find((l) => l.label === "Fresh Creative Drop")?.status).toBe("coming_soon");
  });
});

describe("deliverable shot methods", () => {
  it("keeps every still method and drops video and avatar while their features are coming soon", () => {
    expect(isShotMethodDeliverable("deterministic")).toBe(true);
    expect(isShotMethodDeliverable("composite_generate")).toBe(true);
    expect(isShotMethodDeliverable("edit_generate")).toBe(true);
    expect(isShotMethodDeliverable("template")).toBe(true);
    expect([...undeliverableShotMethods].sort()).toEqual(["avatar", "video_generate"]);
  });

  it("follows the feature status of each method", () => {
    for (const [method, features] of Object.entries(shotMethodFeatures)) {
      const live = features.length === 0 || features.some((f) => featureStatus[f] === "live");
      expect(undeliverableShotMethods.includes(method as never), method).toBe(!live);
    }
  });

  it("maps the video channel family to the video features", () => {
    expect(channelFamilyFeatures.video).toContain("generativeVideo");
    expect(channelFamilyFeatures.video).toContain("templatedVideo");
  });
});

describe("platform settings seed", () => {
  it("seeds the free signup grant from the free tier", () => {
    const row = platformSettingSeedRows.find((r) => r.key === "free_signup_credits");
    expect(row?.value).toBe(tierByKey("free").creditsOnce);
  });

  it("seeds the output options kill switch on", () => {
    expect(platformSettingSeedRows.find((r) => r.key === "output_options_enabled")?.value).toBe(true);
  });
});

describe("planner tier gates follow the entitlements", () => {
  const profile: ProductProfile = {
    productCount: 1,
    category: "home_kitchen",
    amazonProductTypeGuess: "DRINKING_CUP",
    shopifyTaxonomyGuess: "Home & Garden > Kitchen & Dining",
    name: "Mug",
    formFactor: "mug",
    materials: ["ceramic"],
    dominantColors: [{ name: "blue", hex: "#334455", coveragePct: 60 }],
    dimensions: null,
    preserveText: [],
    preserveLogos: [],
    surface: { reflective: false, transparent: false, textured: false },
    features: ["dishwasher safe"],
    benefits: ["keeps drinks warm"],
    targetBuyer: "coffee drinkers",
    useContexts: ["kitchen counter", "office desk"],
    photographedAngles: ["front", "45", "side"],
    missingAnglesNeeded: [],
    complianceFlags: ["none"],
    imageQuality: { usableForMain: true, issues: [] },
  };

  it("plans video shots only for tiers entitled to them", () => {
    for (const tier of TIER_ORDER) {
      // Video is picked: the planner only plans shots for picked specs.
      const types = planShots(profile, { channels: ["amazon", "video"], tier, creditBudget: 1000 }).shots.map(
        (s) => s.type,
      );
      expect(types.includes("video_hero_6s"), `${tier} hero`).toBe(isEntitled(tier, "generativeVideo"));
      expect(types.includes("video_lifestyle_15s"), `${tier} lifestyle`).toBe(isEntitled(tier, "lifestyleVideo"));
      expect(types.includes("video_ugc_hook"), `${tier} ugc`).toBe(isEntitled(tier, "ugcAds"));
    }
  });

  it("lists each gated video shot as skipped once", () => {
    const skipped = planShots(profile, { channels: ["amazon"], tier: "starter", creditBudget: 1000 }).skipped.map(
      (s) => s.type,
    );
    expect(skipped.filter((t) => t === "video_lifestyle_15s")).toHaveLength(1);
    expect(skipped.filter((t) => t === "video_ugc_hook")).toHaveLength(1);
    expect(skipped).toContain("video_hero_6s");
  });
});
