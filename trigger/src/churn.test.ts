import { describe, expect, it } from "vitest";
import {
  AT_RISK_BONUS_CREDITS,
  CHURN_WEIGHTS,
  actionsFor,
  bandFor,
  scoreChurn,
  type ChurnSignals,
} from "./churn";

/** A workspace showing no churn risk at all. */
function healthySignals(overrides: Partial<ChurnSignals> = {}): ChurnSignals {
  return {
    daysSinceLastLogin: 1,
    pastMidCycle: true,
    creditsUsedShare: 0.6,
    avgRejectedAssetsPerPack: 0,
    paymentFailed: false,
    visitedCancelOrBillingPage: false,
    hasShopifyConnection: true,
    ...overrides,
  };
}

describe("bandFor boundaries", () => {
  it("puts 39 in healthy", () => {
    expect(bandFor(39)).toBe("healthy");
  });
  it("puts 40 in watch", () => {
    expect(bandFor(40)).toBe("watch");
  });
  it("puts 69 in watch", () => {
    expect(bandFor(69)).toBe("watch");
  });
  it("puts 70 in at_risk", () => {
    expect(bandFor(70)).toBe("at_risk");
  });
  it("covers the extremes", () => {
    expect(bandFor(0)).toBe("healthy");
    expect(bandFor(100)).toBe("at_risk");
  });
});

describe("scoreChurn signals", () => {
  it("scores a fully healthy workspace at zero", () => {
    const result = scoreChurn(healthySignals());
    expect(result.score).toBe(0);
    expect(result.band).toBe("healthy");
    expect(result.recommendations).toEqual([]);
  });

  it("adds 25 for no login in 10 days", () => {
    expect(scoreChurn(healthySignals({ daysSinceLastLogin: 10 })).score).toBe(
      CHURN_WEIGHTS.noLoginTenDays,
    );
    expect(scoreChurn(healthySignals({ daysSinceLastLogin: 9 })).score).toBe(0);
  });

  it("treats a workspace that never logged in as inactive", () => {
    expect(scoreChurn(healthySignals({ daysSinceLastLogin: null })).score).toBe(
      CHURN_WEIGHTS.noLoginTenDays,
    );
  });

  it("adds 20 for under 20 percent credits used at mid cycle", () => {
    expect(scoreChurn(healthySignals({ creditsUsedShare: 0.19 })).score).toBe(
      CHURN_WEIGHTS.lowCreditUseMidCycle,
    );
    expect(scoreChurn(healthySignals({ creditsUsedShare: 0.2 })).score).toBe(0);
  });

  it("ignores low credit use before mid cycle", () => {
    expect(
      scoreChurn(healthySignals({ creditsUsedShare: 0.05, pastMidCycle: false })).score,
    ).toBe(0);
  });

  it("adds 15 for 2 or more rejected assets per pack on average", () => {
    expect(scoreChurn(healthySignals({ avgRejectedAssetsPerPack: 2 })).score).toBe(
      CHURN_WEIGHTS.rejectedAssets,
    );
    expect(scoreChurn(healthySignals({ avgRejectedAssetsPerPack: 1.9 })).score).toBe(0);
  });

  it("adds 20 for a payment failure", () => {
    expect(scoreChurn(healthySignals({ paymentFailed: true })).score).toBe(
      CHURN_WEIGHTS.paymentFailure,
    );
  });

  it("adds 15 for visiting the cancel or billing page", () => {
    expect(scoreChurn(healthySignals({ visitedCancelOrBillingPage: true })).score).toBe(
      CHURN_WEIGHTS.visitedCancelOrBilling,
    );
  });

  it("adds 5 for a missing Shopify connection", () => {
    expect(scoreChurn(healthySignals({ hasShopifyConnection: false })).score).toBe(
      CHURN_WEIGHTS.noShopifyConnection,
    );
  });

  it("caps the score at 100 when every signal fires", () => {
    const result = scoreChurn({
      daysSinceLastLogin: 30,
      pastMidCycle: true,
      creditsUsedShare: 0,
      avgRejectedAssetsPerPack: 4,
      paymentFailed: true,
      visitedCancelOrBillingPage: true,
      hasShopifyConnection: false,
    });
    expect(result.score).toBe(100);
    expect(result.band).toBe("at_risk");
    expect(result.signals.every((s) => s.triggered)).toBe(true);
  });

  it("lands in watch at 40 with no login plus rejected assets", () => {
    const result = scoreChurn(
      healthySignals({ daysSinceLastLogin: 12, avgRejectedAssetsPerPack: 3 }),
    );
    expect(result.score).toBe(40);
    expect(result.band).toBe("watch");
  });

  it("lands in at_risk at 70 with login, low use, payment and Shopify signals", () => {
    const result = scoreChurn(
      healthySignals({
        daysSinceLastLogin: 12,
        creditsUsedShare: 0.1,
        paymentFailed: true,
        hasShopifyConnection: false,
      }),
    );
    expect(result.score).toBe(70);
    expect(result.band).toBe("at_risk");
  });
});

describe("actionsFor", () => {
  it("recommends nothing for healthy", () => {
    expect(actionsFor("healthy")).toEqual([]);
  });

  it("recommends the next drop email and a free pack at watch", () => {
    expect(actionsFor("watch")).toEqual([
      { kind: "send_email", template: "personalized_next_drop" },
      { kind: "run_free_pack", target: "top_product" },
    ]);
  });

  it("recommends founder email, 50 bonus credits and a pause offer at risk", () => {
    const actions = actionsFor("at_risk");
    expect(actions).toEqual([
      { kind: "send_founder_email" },
      { kind: "grant_bonus_credits", credits: AT_RISK_BONUS_CREDITS },
      { kind: "offer_pause_instead_of_cancel" },
    ]);
    expect(AT_RISK_BONUS_CREDITS).toBe(50);
  });
});
