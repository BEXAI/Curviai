/**
 * Client safe plan helpers shared by /pricing, /app/billing and the billing
 * API. Every price, credit amount and saving is derived from the seed in
 * @curvi/pipeline/seed (CLAUDE.md rule 2); only display names and wording
 * live here.
 */

import { tiers, type TierDefinition, type TierKey } from "@curvi/pipeline/seed";

export type BillingCadence = "monthly" | "annual";

export const BILLING_CADENCES: readonly BillingCadence[] = ["monthly", "annual"];

export type PaidTierKey = Exclude<TierKey, "free">;

/** Tiers that can be bought, in seed order. */
export const paidTiers: TierDefinition[] = tiers.filter((tier) => tier.monthlyUsd > 0);

export const paidTierKeys: PaidTierKey[] = paidTiers.map((tier) => tier.key as PaidTierKey);

export function isPaidTierKey(value: unknown): value is PaidTierKey {
  return typeof value === "string" && (paidTierKeys as string[]).includes(value);
}

export function isBillingCadence(value: unknown): value is BillingCadence {
  return value === "monthly" || value === "annual";
}

const DISPLAY_NAMES: Record<TierKey, string> = {
  free: "Free",
  starter: "Starter",
  growth: "Growth",
  pro: "Pro",
  agency: "Agency",
};

/** Human name for a plan key, e.g. "growth" to "Growth". Unknown keys are
 * capitalized so a stray value never renders as an empty label. */
export function tierDisplayName(plan: string): string {
  if (plan in DISPLAY_NAMES) {
    return DISPLAY_NAMES[plan as TierKey];
  }
  return plan.length > 0 ? plan[0].toUpperCase() + plan.slice(1) : "Free";
}

/** What one year costs on the annual plan. */
export function annualTotalUsd(tier: TierDefinition): number {
  return tier.annualUsdPerMonth * 12;
}

/** Dollars saved over a year by paying annually. */
export function annualSavingsUsd(tier: TierDefinition): number {
  return Math.max(0, (tier.monthlyUsd - tier.annualUsdPerMonth) * 12);
}

/** Whole percent saved by paying annually, rounded down so the claim never
 * overstates the real discount. */
export function annualSavingsPct(tier: TierDefinition): number {
  if (tier.monthlyUsd <= 0) {
    return 0;
  }
  return Math.floor((1 - tier.annualUsdPerMonth / tier.monthlyUsd) * 100);
}

/** The largest whole percent any paid tier saves on annual billing. */
export function maxAnnualSavingsPct(): number {
  return paidTiers.reduce((max, tier) => Math.max(max, annualSavingsPct(tier)), 0);
}

/** Credits a paid invoice for one full billing period grants. Annual plans
 * grant the full year up front on the paid annual invoice (Phase 10
 * decision 2). */
export function allowanceCredits(creditsPerMonth: number, cadence: BillingCadence): number {
  return cadence === "annual" ? creditsPerMonth * 12 : creditsPerMonth;
}

export interface CadencePrice {
  /** Effective price per month. */
  perMonthUsd: number;
  /** Amount charged per invoice. */
  billedUsd: number;
  /** Credits added when that invoice is paid. */
  creditsPerInvoice: number;
}

export function priceForCadence(tier: TierDefinition, cadence: BillingCadence): CadencePrice {
  if (cadence === "annual") {
    return {
      perMonthUsd: tier.annualUsdPerMonth,
      billedUsd: annualTotalUsd(tier),
      creditsPerInvoice: allowanceCredits(tier.creditsPerMonth, "annual"),
    };
  }
  return {
    perMonthUsd: tier.monthlyUsd,
    billedUsd: tier.monthlyUsd,
    creditsPerInvoice: tier.creditsPerMonth,
  };
}

export function formatUsd(amount: number): string {
  return `$${amount.toLocaleString("en-US")}`;
}

export function formatCredits(amount: number): string {
  return `${amount.toLocaleString("en-US")} ${amount === 1 ? "credit" : "credits"}`;
}
