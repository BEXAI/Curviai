/**
 * Credit costs and tier definitions from CURVI_BUILD_PLAN.md section 9.1.
 * Prices and credit amounts live ONLY here (CLAUDE.md rule 2); they seed the
 * billing tables and are never hardcoded in logic code.
 */

export const creditCosts = {
  /** White main, cutout, resize or sweep. */
  deterministic: 0.5,
  /** One generative still at up to 2K. */
  generativeStill: 1,
  /** A 4K or Pro model still. */
  pro4kStill: 3,
  /** A templated video. */
  templatedVideo: 2,
  /** Generative video, per second, Lite. */
  generativeVideoPerSecondLite: 1,
  /** Generative video, per second, premium. */
  generativeVideoPerSecondPremium: 3,
  /** A UGC avatar ad. */
  ugcAvatarAd: 30,
} as const;

export type CreditCostKey = keyof typeof creditCosts;

export interface TierDefinition {
  key: "free" | "starter" | "growth" | "pro" | "agency";
  monthlyUsd: number;
  /** Effective monthly price on the annual plan (about 20 percent off). */
  annualUsdPerMonth: number;
  /** Monthly credit allowance. Free is a one time grant, see creditsOnce. */
  creditsPerMonth: number;
  /** One time credit grant, used by the free tier. */
  creditsOnce: number;
  includes: string[];
}

/** Annual billing discount applied to monthly prices. */
export const annualDiscountPct = 0.2;

export const tiers: TierDefinition[] = [
  {
    key: "free",
    monthlyUsd: 0,
    annualUsdPerMonth: 0,
    creditsPerMonth: 0,
    creditsOnce: 15,
    includes: ["1 compliant main image plus 2 lifestyle", "share page"],
  },
  {
    key: "starter",
    monthlyUsd: 29,
    annualUsdPerMonth: 24,
    creditsPerMonth: 200,
    creditsOnce: 0,
    includes: ["1 brand kit", "all image assets", "templated video"],
  },
  {
    key: "growth",
    monthlyUsd: 79,
    annualUsdPerMonth: 66,
    creditsPerMonth: 600,
    creditsOnce: 0,
    includes: ["generative video", "Fresh Creative Drop", "Shopify auto packs"],
  },
  {
    key: "pro",
    monthlyUsd: 149,
    annualUsdPerMonth: 124,
    creditsPerMonth: 1300,
    creditsOnce: 0,
    includes: ["UGC hook ads", "3 brand kits", "priority queue"],
  },
  {
    key: "agency",
    monthlyUsd: 349,
    annualUsdPerMonth: 290,
    creditsPerMonth: 3500,
    creditsOnce: 0,
    includes: ["10 client workspaces", "client review links", "white label share pages"],
  },
];

export type TierKey = TierDefinition["key"];

export interface TopUp {
  credits: number;
  usd: number;
  /** Months before top up credits expire. */
  expiresMonths: number;
}

export const topUps: TopUp[] = [
  { credits: 100, usd: 15, expiresMonths: 12 },
  { credits: 500, usd: 60, expiresMonths: 12 },
];

/** Unused subscription credits roll over for one cycle, capped at one month's allowance. */
export const rolloverPolicy = { cycles: 1, capFactorOfMonthlyAllowance: 1 } as const;

export function tierByKey(key: TierKey): TierDefinition {
  const tier = tiers.find((t) => t.key === key);
  if (!tier) {
    throw new Error(`Unknown tier: ${key}`);
  }
  return tier;
}
