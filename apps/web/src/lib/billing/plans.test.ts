import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { creditCosts, tierByKey, tiers, topUps } from "@curvi/pipeline/seed";
import { estimatePackCredits } from "@/lib/pack-estimate";
import { billingCheckoutHref, parseCheckoutIntent, parseCheckoutStatus, signupHref } from "./intent";
import { comingSoonFeatures, includedFeatures, planFeatures } from "./plan-features";
import {
  allowanceCredits,
  annualSavingsPct,
  annualTotalUsd,
  annualSavingsUsd,
  maxAnnualSavingsPct,
  paidTierKeys,
  paidTiers,
  priceForCadence,
  tierDisplayName,
} from "./plans";
import { packsPerMonth, stillPackCredits, TYPICAL_PACK_CHANNELS } from "./pricing-copy";
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
    const best = Math.max(
      ...tiers.filter((t) => t.monthlyUsd > 0).map((t) => (1 - t.annualUsdPerMonth / t.monthlyUsd) * 100),
    );
    expect(maxAnnualSavingsPct()).toBe(Math.floor(best));
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

describe("pricing copy numbers", () => {
  it("quotes the pack size the estimate would charge, not a fixed range", () => {
    const expected = estimatePackCredits(TYPICAL_PACK_CHANNELS, "listing", "starter").total;
    expect(stillPackCredits()).toBe(expected);
    expect(stillPackCredits()).toBeGreaterThanOrEqual(creditCosts.deterministic);
    expect(packsPerMonth(tierByKey("starter").creditsPerMonth)).toBe(
      Math.floor(tierByKey("starter").creditsPerMonth / expected),
    );
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
    expect(parseCheckoutIntent({ checkout: ["agency", "pro"], cadence: ["annual"] })).toEqual({
      tier: "agency",
      cadence: "annual",
    });
    expect(parseCheckoutIntent({})).toBeNull();
    for (const key of paidTierKeys) {
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
