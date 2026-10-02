import { describe, expect, it } from "vitest";
import {
  economics,
  foundingMemberOffer,
  retentionOffers,
  tierByKey,
  tiers,
  topUps,
} from "../seed";
import {
  afterPaymentFee,
  buildEconomicsReport,
  creditOffers,
  creditsPerStill,
  distribution,
  grossMargin,
  percentile,
  priceFloor,
  roundUpToHalfCredit,
  seedOffers,
  type EconomicsInputs,
} from "./index";

// docs/phases/PHASE_20.md P20-04: revenue per credit, the price floor and
// the price rule, from the seed.

describe("revenue per credit from the seed", () => {
  const offers = creditOffers();
  const byKey = new Map(offers.map((offer) => [offer.key, offer]));

  it("lists every paid tier at both cadences, every top up, the founding offer at both cadences and the save offer", () => {
    for (const tier of tiers.filter((t) => t.monthlyUsd > 0)) {
      expect(byKey.get(`plan:${tier.key}:monthly`)?.revenuePerCredit).toBeCloseTo(tier.monthlyUsd / tier.creditsPerMonth, 10);
      expect(byKey.get(`plan:${tier.key}:annual`)?.revenuePerCredit).toBeCloseTo(
        (tier.annualUsdPerMonth * 12) / (tier.creditsPerMonth * 12),
        10,
      );
      expect(byKey.get(`save_offer:${tier.key}:monthly`)?.revenuePerCredit).toBeCloseTo(
        (tier.monthlyUsd * (100 - retentionOffers.discount.percentOff)) / 100 / tier.creditsPerMonth,
        10,
      );
      expect(byKey.has(`save_offer:${tier.key}:annual`)).toBe(false);
    }
    for (const topUp of topUps) {
      expect(byKey.get(`top_up:${topUp.credits}`)?.revenuePerCredit).toBeCloseTo(topUp.usd / topUp.credits, 10);
    }
    const starter = tierByKey("starter");
    expect(byKey.get("founding:monthly")?.revenuePerCredit).toBeCloseTo(foundingMemberOffer.monthlyUsd / starter.creditsPerMonth, 10);
    expect(byKey.get("founding:annual")?.revenuePerCredit).toBeCloseTo(
      foundingMemberOffer.annualUsd / (starter.creditsPerMonth * 12),
      10,
    );
    expect(byKey.has("plan:free:monthly")).toBe(false);
  });

  it("takes the seeded payment fee off each charge", () => {
    for (const offer of offers) {
      expect(offer.netRevenuePerCredit).toBeCloseTo(afterPaymentFee(offer.usd, economics.paymentFee) / offer.credits, 10);
      expect(offer.netRevenuePerCredit).toBeLessThan(offer.revenuePerCredit);
    }
  });

  it("sets the floor at the minimum over every self serve offer", () => {
    const floor = priceFloor(offers);
    const selfServe = offers.filter((offer) => offer.selfServe);
    expect(floor.gross.revenuePerCredit).toBe(Math.min(...selfServe.map((offer) => offer.revenuePerCredit)));
    expect(floor.net.netRevenuePerCredit).toBe(Math.min(...selfServe.map((offer) => offer.netRevenuePerCredit)));
  });

  it("with Agency off self serve (P20-08), the floor is the founding annual price", () => {
    const seed = seedOffers();
    const withoutAgency = creditOffers({
      ...seed,
      tiers: seed.tiers.map((tier) => (tier.key === "agency" ? { ...tier, selfServe: false } : tier)),
    });
    expect(priceFloor(withoutAgency).gross.key).toBe("founding:annual");
    expect(withoutAgency.filter((offer) => offer.tier === "agency" && offer.kind !== "founding").every((offer) => !offer.selfServe)).toBe(
      true,
    );
  });

  it("reads Agency off self serve from the seed itself (P20-08), so today's floor is the founding annual offer", () => {
    expect(priceFloor(creditOffers(seedOffers())).gross.key).toBe("founding:annual");
  });
});

describe("the price rule", () => {
  it("rounds up to the next half credit", () => {
    expect(roundUpToHalfCredit(2.53)).toBe(3);
    expect(roundUpToHalfCredit(1.9)).toBe(2);
    expect(roundUpToHalfCredit(2.5)).toBe(2.5);
    expect(roundUpToHalfCredit(2.01)).toBe(2.5);
  });

  it("matches the plan's worked examples at a 60 percent margin over a $0.079 floor", () => {
    expect(creditsPerStill({ p90CostUsd: 0.08, floorRevenuePerCredit: 0.079, targetGrossMargin: 0.6 })).toBe(3);
    expect(creditsPerStill({ p90CostUsd: 0.06, floorRevenuePerCredit: 0.079, targetGrossMargin: 0.6 })).toBe(2);
  });

  it("uses the seeded target margin by default and never goes below half a credit", () => {
    const floor = 0.1;
    expect(creditsPerStill({ p90CostUsd: 0.05, floorRevenuePerCredit: floor })).toBe(
      roundUpToHalfCredit(0.05 / (floor * (1 - economics.targetGrossMargin))),
    );
    expect(creditsPerStill({ p90CostUsd: 0, floorRevenuePerCredit: floor })).toBe(0.5);
    expect(() => creditsPerStill({ p90CostUsd: 0.05, floorRevenuePerCredit: 0 })).toThrow();
  });

  it("computes margins and percentiles", () => {
    expect(grossMargin(10, 4)).toBeCloseTo(0.6, 10);
    expect(grossMargin(0, 4)).toBeNull();
    expect(percentile([], 90)).toBeNull();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBeCloseTo(5.5, 10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBeCloseTo(9.1, 10);
    expect(distribution([2, 4])).toEqual({ count: 2, mean: 3, p50: 3, p90: 3.8 });
  });
});

describe("buildEconomicsReport", () => {
  const inputs: EconomicsInputs = {
    shots: [
      { jobId: "j1", method: "composite_generate", costMicros: 60_000, attempts: 1 },
      { jobId: "j1", method: "edit_generate", costMicros: 80_000, attempts: 2 },
      { jobId: "j1", method: "deterministic", costMicros: 10_000, attempts: 1 },
      { jobId: "j2", method: null, costMicros: 5_000, attempts: 1 },
    ],
    undelivered: [{ jobId: "j1", costMicros: 50_000 }],
    packs: [
      { jobId: "j1", cogsMicros: 300_000, creditsCharged: 3, llmMicrosByFamily: { openai: 100_000, anthropic: 20_000 } },
      { jobId: "j2", cogsMicros: 40_000, creditsCharged: 1, llmMicrosByFamily: {} },
    ],
    stages: [{ stage: "lifestyle", status: "done", rows: 2, costMicros: 140_000 }],
  };

  it("groups shot cost by method and takes the generative still p90 from both generative methods", () => {
    const report = buildEconomicsReport(inputs, { days: 30, creditFamilies: [], currentCreditsPerStill: 1 });
    expect(report.perShotByMethod.map((row) => row.method)).toEqual(["composite_generate", "deterministic", "edit_generate", "unknown"]);
    expect(report.generativeStill).toMatchObject({ count: 2, p50: 0.07 });
    expect(report.generativeStill.p90).toBeCloseTo(0.078, 10);
  });

  it("shows pack cost at list price and with a provider credit that pays a family's LLM calls", () => {
    const report = buildEconomicsReport(inputs, { days: 30, creditFamilies: ["openai"], currentCreditsPerStill: 1 });
    expect(report.perPack.atListPrice.mean).toBeCloseTo(0.17, 10);
    expect(report.perPack.withCredit.mean).toBeCloseTo((0.2 + 0.04) / 2, 10);
  });

  it("reports retry overhead and the rule from the floor", () => {
    const report = buildEconomicsReport(inputs, { days: 30, creditFamilies: [], currentCreditsPerStill: 1 });
    expect(report.retry).toMatchObject({ deliveredShots: 4, retriedShare: 0.25, meanAttempts: 1.25 });
    expect(report.retry.undeliveredCostShare).toBeCloseTo(50_000 / 205_000, 10);
    const floor = priceFloor().gross.revenuePerCredit;
    expect(report.rule.fromGrossFloor).toBe(
      creditsPerStill({ p90CostUsd: report.generativeStill.p90!, floorRevenuePerCredit: floor }),
    );
    expect(report.rule.marginAtCurrentPrice).toBeCloseTo(1 - report.generativeStill.p90! / floor, 10);
  });

  it("has no rule answer without a delivered generative still", () => {
    const report = buildEconomicsReport(
      { shots: [], undelivered: [], packs: [], stages: [] },
      { days: 7, creditFamilies: [], currentCreditsPerStill: 1 },
    );
    expect(report.rule).toMatchObject({ fromGrossFloor: null, fromNetFloor: null, marginAtCurrentPrice: null });
    expect(report.retry).toMatchObject({ deliveredShots: 0, retriedShare: null, undeliveredCostShare: null });
  });
});
