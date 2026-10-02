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

/**
 * Paid tiers sold online, in seed order (docs/phases/PHASE_20.md P20-08):
 * the ones /pricing and the /app/billing plan picker show and checkout
 * takes. A tier the seed marks `selfServe: false` (Agency) is set up by
 * email instead, and paidTiers still names it for a subscription that has it.
 */
export const selfServeTiers: TierDefinition[] = paidTiers.filter((tier) => tier.selfServe);

export const selfServeTierKeys: PaidTierKey[] = selfServeTiers.map((tier) => tier.key as PaidTierKey);

export function isSelfServeTierKey(value: unknown): value is PaidTierKey {
  return typeof value === "string" && (selfServeTierKeys as string[]).includes(value);
}

/** Shown where a larger plan would be: below Pro on /pricing and the plan
 * picker, and in a checkout refusal for a tier that is not sold online. */
export const LARGER_PLAN_LINE = "Need more than Pro? Email us and we will set up a larger plan.";

/** The address the larger plan line sends buyers to (decision 24's inbox). */
export const LARGER_PLAN_EMAIL = "hello@curvi.ai";

/** docs/phases/PHASE_20.md P20-06, P0 stopgap: a subscriber moves to a
 * smaller plan by email, and the founder schedules it for the period end. */
export const DOWNGRADE_BY_EMAIL_LINE = "Email us to move to a smaller plan. It takes effect at your next renewal.";

/** P20-06 stopgap: a yearly subscriber moves to monthly billing by email,
 * at the next renewal, even onto a bigger plan. */
export const MONTHLY_BY_EMAIL_LINE = "Email us to switch to monthly billing. It takes effect at your next renewal.";

/** True when `tier` is a smaller paid plan than `current`. */
export function isSmallerPlan(tier: string, current: string): boolean {
  const rank = paidTierKeys.indexOf(tier as PaidTierKey);
  const currentRank = paidTierKeys.indexOf(current as PaidTierKey);
  return rank >= 0 && currentRank >= 0 && rank < currentRank;
}

/** One plan at one cadence: one Stripe price. */
export interface PlanPrice {
  tier: PaidTierKey;
  cadence: BillingCadence;
}

/**
 * The prices a subscriber on `from` may move to online, at once, through
 * the portal (docs/phases/PHASE_20.md P20-06 stopgap): what that plan's
 * upgrade only portal configuration lists. From monthly: the same plan
 * yearly, and every bigger plan sold online at either cadence. From yearly:
 * only the bigger plans' yearly prices, because yearly to monthly returns
 * money for the rest of the year and would take its credits back at once,
 * even onto a bigger plan. Never Agency, which is not sold online.
 */
export function upgradeTargets(from: PlanPrice): PlanPrice[] {
  const rank = paidTierKeys.indexOf(from.tier);
  const bigger = selfServeTierKeys.filter((key) => paidTierKeys.indexOf(key) > rank);
  if (from.cadence === "annual") {
    return bigger.map((tier) => ({ tier, cadence: "annual" }));
  }
  return [
    ...(isSelfServeTierKey(from.tier) ? [{ tier: from.tier, cadence: "annual" as const }] : []),
    ...bigger.flatMap((tier) => BILLING_CADENCES.map((cadence) => ({ tier, cadence }))),
  ];
}

export type PlanChangeDirection = "upgrade" | "downgrade" | "same";

/**
 * An upgrade is a move to one of upgradeTargets (it applies at once in the
 * portal); anything else is a downgrade, which the founder schedules for
 * the next renewal by email. An unknown current price counts as a
 * downgrade, so nothing is changed online that might take credits back.
 */
export function planChangeDirection(from: PlanPrice | null, to: PlanPrice): PlanChangeDirection {
  if (!from) {
    return "downgrade";
  }
  if (from.tier === to.tier && from.cadence === to.cadence) {
    return "same";
  }
  return upgradeTargets(from).some((target) => target.tier === to.tier && target.cadence === to.cadence)
    ? "upgrade"
    : "downgrade";
}

/** What to tell a subscriber whose change goes by email: a yearly plan
 * moving to monthly billing on the same or a bigger plan, or a smaller plan. */
export function downgradeByEmailLine(from: PlanPrice | null, to: PlanPrice): string {
  if (from && from.cadence === "annual" && to.cadence === "monthly" && !isSmallerPlan(to.tier, from.tier)) {
    return MONTHLY_BY_EMAIL_LINE;
  }
  return DOWNGRADE_BY_EMAIL_LINE;
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
