import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { entitlementsFor, featureStatus, tierByKey, tiers, topUps, type TierFeature } from "@curvi/pipeline/seed";
import { FEATURES, unqualifiedClaims, type FeatureKey } from "@/lib/marketing-facts";
import { billingCheckoutHref, parseCheckoutIntent, parseCheckoutStatus, signupHref } from "./intent";
import { comingSoonFeatures, includedFeatures, onTheWay, planCardFeatureKeys, planFeatures } from "./plan-features";
import {
  allowanceCredits,
  annualSavingsPct,
  annualTotalUsd,
  annualSavingsUsd,
  paidTierKeys,
  paidTiers,
  priceForCadence,
  selfServeTierKeys,
  tierDisplayName,
} from "./plans";
import { tierPriceEnvName, topUpPriceEnvName } from "./price-table";
import { HANDLED_STRIPE_EVENTS } from "./stripe-webhook";

describe("plan math from the seed", () => {
  it("computes annual savings from the seed prices, never overstating them", () => {
    for (const tier of tiers.filter((t) => t.monthlyUsd > 0)) {
      const exact = (1 - tier.annualUsdPerMonth / tier.monthlyUsd) * 100;
      expect(annualSavingsPct(tier)).toBeLessThanOrEqual(exact);
      expect(annualSavingsPct(tier)).toBeGreaterThan(exact - 1);
      expect(annualSavingsUsd(tier)).toBe((tier.monthlyUsd - tier.annualUsdPerMonth) * 12);
    }
  });

  it("grants a full year of credits on an annual invoice", () => {
    const growth = tierByKey("growth");
    expect(allowanceCredits(growth.creditsPerMonth, "annual")).toBe(growth.creditsPerMonth * 12);
    expect(priceForCadence(growth, "annual")).toEqual({
      perMonthUsd: growth.annualUsdPerMonth,
      billedUsd: growth.annualUsdPerMonth * 12,
      creditsPerInvoice: growth.creditsPerMonth * 12,
    });
    expect(priceForCadence(growth, "monthly").billedUsd).toBe(growth.monthlyUsd);
  });

  it("names plans for people", () => {
    expect(tierDisplayName("growth")).toBe("Growth");
    expect(tierDisplayName("free")).toBe("Free");
    expect(tierDisplayName("custom")).toBe("Custom");
  });
});

describe("plan features (Phase 10 decision 1)", () => {
  it("never lists a coming soon feature as included", () => {
    for (const tier of tiers) {
      const included = includedFeatures(tier.key);
      for (const item of comingSoonFeatures(tier.key)) {
        expect(included).not.toContain(item);
      }
      expect(planFeatures(tier.key).length).toBeGreaterThan(0);
    }
  });

  it("takes each line's status from the site wide feature flags", () => {
    const labels = (tier: (typeof tiers)[number]["key"]) => planFeatures(tier).map((feature) => feature.label);
    for (const tier of tiers) {
      for (const feature of planFeatures(tier.key)) {
        // A line sold as included never names a feature that is not live, and
        // a coming soon line always names one, so a flag flip moves it.
        const claims = unqualifiedClaims(feature.label);
        if (feature.status === "live") {
          expect(claims, `${tier.key}: ${feature.label}`).toEqual([]);
        } else {
          expect(claims.length, `${tier.key}: ${feature.label}`).toBeGreaterThan(0);
        }
      }
    }
    const videoStatus: string = FEATURES.video.status;
    expect(videoStatus === "live").toBe(includedFeatures("growth").includes("Generative video"));
    expect(labels("pro")).toContain(`${entitlementsFor("pro").brandKits} brand kits`);
    expect(labels("agency")).toContain(`${entitlementsFor("agency").clientWorkspaces} client workspaces`);
    expect(labels("starter")).toContain(`${entitlementsFor("starter").brandKits} brand kit`);
  });

  it("keeps features that do not run yet under coming soon", () => {
    const notLive = [
      "Templated video",
      "Generative video",
      "Fresh Creative Drop every Monday",
      "Shopify auto packs for new products",
      "UGC hook ads",
      "3 brand kits",
      "Priority queue",
      "10 client workspaces",
      "Client review links",
      "White label share pages",
    ];
    const allIncluded = tiers.flatMap((tier) => includedFeatures(tier.key));
    for (const label of notLive) {
      expect(allIncluded).not.toContain(label);
    }
  });
});

describe("plan cards list only what runs; Agency off self serve (P20-08)", () => {
  it("sells Starter, Growth and Pro online and keeps Agency for email", () => {
    expect(selfServeTierKeys).toEqual(["starter", "growth", "pro"]);
    expect(tiers.filter((tier) => !tier.selfServe).map((tier) => tier.key)).toEqual(["agency"]);
  });

  it("puts no coming soon line inside any card", () => {
    for (const key of selfServeTierKeys) {
      for (const label of includedFeatures(key)) {
        expect(unqualifiedClaims(label), `${key}: ${label}`).toEqual([]);
      }
    }
  });

  it("builds on the plan below", () => {
    expect(includedFeatures("growth")[0]).toBe("Everything in Starter");
    expect(includedFeatures("pro")[0]).toBe("Everything in Growth");
  });

  it("lists every line that does not run yet once, under the smallest plan sold online that gets it", () => {
    const lines = onTheWay();
    const expected = [...new Set(selfServeTierKeys.flatMap((key) => comingSoonFeatures(key)))];
    expect(lines.map((line) => line.label)).toEqual(expected);
    for (const line of lines) {
      const first = selfServeTierKeys.find((key) => comingSoonFeatures(key).includes(line.label));
      expect(line.fromTier).toBe(first);
      expect(line.plans).toBe(line.fromTier === "pro" ? "Pro" : `${tierDisplayName(line.fromTier)} and up`);
    }
    // Agency's own lines are not offered on a page that does not sell it.
    for (const label of comingSoonFeatures("agency").filter((label) => !expected.includes(label))) {
      expect(lines.map((line) => line.label)).not.toContain(label);
    }
  });

  it("keeps FEATURES and the seed's featureStatus in step for every flag a card reads", () => {
    // The seed plan features each card flag stands for. A new flag a card
    // reads must be mapped here, so the two sources can never drift.
    const seedFeatures: Partial<Record<FeatureKey, readonly TierFeature[]>> = {
      whiteMainImage: [],
      lifestyleScenes: [],
      complianceReport: [],
      sharePages: ["sharePage"],
      brandKitColors: ["brandKit"],
      video: ["templatedVideo", "generativeVideo", "lifestyleVideo"],
      freshCreativeDrop: ["freshDrop"],
      shopifyAutoPacks: ["shopifyAutoPacks"],
      ugcAds: ["ugcAds"],
      multipleBrandKits: ["multipleBrandKits"],
      priorityQueue: ["priorityQueue"],
      agencyWorkspaces: ["clientWorkspaces"],
      reviewLinks: ["clientReviewLinks"],
      whiteLabel: ["whiteLabelShare"],
    };
    for (const key of planCardFeatureKeys()) {
      const mapped = seedFeatures[key];
      expect(mapped, `card flag ${key} has no seed mapping`).toBeDefined();
      for (const feature of mapped ?? []) {
        expect(featureStatus[feature], `${key} and ${feature}`).toBe(FEATURES[key].status);
      }
    }
  });
});

describe("plan intent (money-pricing-intent)", () => {
  it("builds signup and billing links that carry the plan", () => {
    expect(signupHref({ plan: "growth", cadence: "annual", source: "pricing" })).toBe(
      "/signup?plan=growth&cadence=annual&source=pricing",
    );
    expect(signupHref({ source: "pricing" })).toBe("/signup?source=pricing");
    expect(billingCheckoutHref({ tier: "pro", cadence: "monthly" })).toBe("/app/billing?checkout=pro&cadence=monthly");
  });

  it("parses only real paid tiers and known cadences", () => {
    expect(parseCheckoutIntent({ checkout: "growth", cadence: "annual" })).toEqual({ tier: "growth", cadence: "annual" });
    expect(parseCheckoutIntent({ checkout: "starter_annual" })).toEqual({ tier: "starter", cadence: "annual" });
    expect(parseCheckoutIntent({ checkout: "pro", cadence: "weekly" })).toEqual({ tier: "pro", cadence: "monthly" });
    expect(parseCheckoutIntent({ checkout: "free" })).toBeNull();
    expect(parseCheckoutIntent({ checkout: "enterprise" })).toBeNull();
    expect(parseCheckoutIntent({ checkout: ["pro", "growth"], cadence: ["annual"] })).toEqual({
      tier: "pro",
      cadence: "annual",
    });
    // Agency is set up by email (P20-08), so a crafted link selects nothing.
    expect(parseCheckoutIntent({ checkout: "agency", cadence: "annual" })).toBeNull();
    expect(parseCheckoutIntent({ checkout: "agency_monthly" })).toBeNull();
    expect(parseCheckoutIntent({})).toBeNull();
    for (const key of selfServeTierKeys) {
      expect(parseCheckoutIntent({ checkout: key })?.tier).toBe(key);
    }
  });

  it("parses the Stripe return status", () => {
    expect(parseCheckoutStatus("success")).toBe("success");
    expect(parseCheckoutStatus("canceled")).toBe("canceled");
    expect(parseCheckoutStatus("other")).toBeNull();
    expect(parseCheckoutStatus(undefined)).toBeNull();
  });
});

describe("docs/STRIPE_SETUP.md stays in step with the code", () => {
  const doc = readFileSync(fileURLToPath(new URL("../../../../../docs/STRIPE_SETUP.md", import.meta.url)), "utf8");

  it("lists every seed price, credit grant and price env var", () => {
    for (const tier of paidTiers) {
      const key = tier.key as (typeof paidTierKeys)[number];
      expect(doc).toContain(`\`${tierPriceEnvName(key, "monthly")}\``);
      expect(doc).toContain(`\`${tierPriceEnvName(key, "annual")}\``);
      expect(doc).toContain(`$${tier.monthlyUsd.toLocaleString("en-US")} (${tier.monthlyUsd * 100})`);
      expect(doc).toContain(`$${annualTotalUsd(tier).toLocaleString("en-US")} (${annualTotalUsd(tier) * 100})`);
      expect(doc).toContain(allowanceCredits(tier.creditsPerMonth, "annual").toLocaleString("en-US"));
    }
    for (const topUp of topUps) {
      expect(doc).toContain(`\`${topUpPriceEnvName(topUp.credits)}\``);
      expect(doc).toContain(`$${topUp.usd} (${topUp.usd * 100})`);
    }
  });

  it("lists exactly the webhook events the handler acts on", () => {
    for (const type of HANDLED_STRIPE_EVENTS) {
      expect(doc).toContain(`- \`${type}\``);
    }
    const listed = [...doc.matchAll(/^  - `([a-z_.]+)`$/gm)].map((match) => match[1]);
    expect(listed.sort()).toEqual([...HANDLED_STRIPE_EVENTS].sort());
  });
});
