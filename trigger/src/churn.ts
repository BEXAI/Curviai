/**
 * Churn risk scorer, pure code implementing CURVI_BUILD_PLAN.md section 9.8
 * exactly. The weights, band boundaries and retention parameters below are
 * platform constants fixed by the plan; this module is their single home,
 * mirroring how @curvi/ai caps.ts owns the section 4.4 spend caps.
 */

export const CHURN_WEIGHTS = {
  /** No login for 10 days. */
  noLoginTenDays: 25,
  /** Under 20 percent of credits used by mid cycle. */
  lowCreditUseMidCycle: 20,
  /** Two or more assets rejected or regenerated per pack on average. */
  rejectedAssets: 15,
  /** A payment failure this cycle. */
  paymentFailure: 20,
  /** Visited the cancel or billing page. */
  visitedCancelOrBilling: 15,
  /** No Shopify connection. */
  noShopifyConnection: 5,
} as const;

export type ChurnSignalKey = keyof typeof CHURN_WEIGHTS;

export const CHURN_THRESHOLDS = {
  noLoginDays: 10,
  /** Strictly under this share of credits used counts as low. */
  lowCreditUseShare: 0.2,
  /** At or above this average rejected assets per pack counts. */
  rejectedAssetsPerPack: 2,
} as const;

/** Bands: 0 to 39 healthy, 40 to 69 watch, 70 or more at risk. */
export const CHURN_BANDS = { watchMin: 40, atRiskMin: 70 } as const;

/** Bonus credits granted with the founder email at the at risk band. */
export const AT_RISK_BONUS_CREDITS = 50;

export type ChurnBand = "healthy" | "watch" | "at_risk";

export interface ChurnSignals {
  /** Days since the last login. null means no login was ever recorded. */
  daysSinceLastLogin: number | null;
  /** True once the billing cycle is at or past its midpoint. */
  pastMidCycle: boolean;
  /** Share of this cycle's credits used so far, 0 to 1. */
  creditsUsedShare: number;
  /** Average assets rejected or regenerated per pack. */
  avgRejectedAssetsPerPack: number;
  /** A payment failed this cycle. */
  paymentFailed: boolean;
  visitedCancelOrBillingPage: boolean;
  hasShopifyConnection: boolean;
}

export type ChurnAction =
  | { kind: "send_email"; template: "personalized_next_drop" }
  | { kind: "run_free_pack"; target: "top_product" }
  | { kind: "send_founder_email" }
  | { kind: "grant_bonus_credits"; credits: number }
  | { kind: "offer_pause_instead_of_cancel" };

export interface ChurnSignalScore {
  key: ChurnSignalKey;
  triggered: boolean;
  points: number;
}

export interface ChurnScore {
  /** Sum of triggered weights, capped at 100. */
  score: number;
  band: ChurnBand;
  signals: ChurnSignalScore[];
  recommendations: ChurnAction[];
}

export function bandFor(score: number): ChurnBand {
  if (score >= CHURN_BANDS.atRiskMin) {
    return "at_risk";
  }
  if (score >= CHURN_BANDS.watchMin) {
    return "watch";
  }
  return "healthy";
}

/**
 * Actions per band from plan 9.8: at watch, send a personalized next drop
 * email and run a free pack on the top product. At risk, send a founder
 * email, grant 50 bonus credits, and offer a pause instead of a cancel.
 */
export function actionsFor(band: ChurnBand): ChurnAction[] {
  switch (band) {
    case "healthy":
      return [];
    case "watch":
      return [
        { kind: "send_email", template: "personalized_next_drop" },
        { kind: "run_free_pack", target: "top_product" },
      ];
    case "at_risk":
      return [
        { kind: "send_founder_email" },
        { kind: "grant_bonus_credits", credits: AT_RISK_BONUS_CREDITS },
        { kind: "offer_pause_instead_of_cancel" },
      ];
  }
}

export function scoreChurn(signals: ChurnSignals): ChurnScore {
  const parts: ChurnSignalScore[] = [
    scored(
      "noLoginTenDays",
      signals.daysSinceLastLogin === null || signals.daysSinceLastLogin >= CHURN_THRESHOLDS.noLoginDays,
    ),
    scored(
      "lowCreditUseMidCycle",
      signals.pastMidCycle && signals.creditsUsedShare < CHURN_THRESHOLDS.lowCreditUseShare,
    ),
    scored("rejectedAssets", signals.avgRejectedAssetsPerPack >= CHURN_THRESHOLDS.rejectedAssetsPerPack),
    scored("paymentFailure", signals.paymentFailed),
    scored("visitedCancelOrBilling", signals.visitedCancelOrBillingPage),
    scored("noShopifyConnection", !signals.hasShopifyConnection),
  ];
  const score = Math.min(
    100,
    parts.reduce((sum, p) => sum + p.points, 0),
  );
  const band = bandFor(score);
  return { score, band, signals: parts, recommendations: actionsFor(band) };
}

function scored(key: ChurnSignalKey, triggered: boolean): ChurnSignalScore {
  return { key, triggered, points: triggered ? CHURN_WEIGHTS[key] : 0 };
}
