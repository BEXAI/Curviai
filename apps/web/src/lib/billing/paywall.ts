/**
 * Copy and offers for the paywall moments: the out of credits dialog when a
 * pack costs more than the balance (createJob's insufficient_credits, the
 * CU402 reservation refusal), the low balance nudge on the dashboard and the
 * new pack page, and the balance in the app header. Client safe: every
 * price and credit amount comes from the seed through plans.ts and
 * marketing-facts.ts (CLAUDE.md rule 2), and only wording lives here.
 *
 * With Stripe off (isStripeConfigured false) nothing links to checkout: the
 * copy says credits are limited during early access and points at
 * /app/billing, where a plan or top up can be requested.
 */

import { tiers, topUps, type TierDefinition, type TopUp } from "@curvi/pipeline/seed";
import { tierKeyOf } from "@/lib/entitlements";
import { topUpMonths, typicalPackCredits } from "@/lib/marketing-facts";
import { billingCheckoutHref } from "./intent";
import { formatCredits, formatUsd, isPaidTierKey, tierDisplayName } from "./plans";

export const BILLING_HREF = "/app/billing";
export const TOP_UPS_HREF = "/app/billing#top-ups";

export interface PaywallContext {
  /** The workspace plan key. */
  plan: string;
  creditBalance: number;
  /** isStripeConfigured() on the server. */
  stripeLive: boolean;
  /** canManageBilling(role): client seats get no billing links. */
  canBill: boolean;
}

export interface PaywallAction {
  label: string;
  href: string;
  primary: boolean;
}

export interface PaywallCopy {
  title: string;
  paragraphs: string[];
  actions: PaywallAction[];
}

/** Below one default listing pack of stills, the balance counts as low. */
export function lowBalanceThreshold(): number {
  return typicalPackCredits();
}

/** A balance that cannot cover one more typical pack. A balance below zero
 * has its own explanation wherever it shows, so it is not "low". */
export function isLowBalance(creditBalance: number, threshold: number = lowBalanceThreshold()): boolean {
  return creditBalance >= 0 && creditBalance < threshold;
}

/**
 * The plan to offer: the first paid plan above the current one whose monthly
 * credits cover `needed`, else the next plan up. Null on the top plan.
 */
export function suggestedTier(plan: string, needed: number): TierDefinition | null {
  const current = tiers.findIndex((tier) => tier.key === tierKeyOf(plan));
  const above = tiers.slice(current + 1).filter((tier) => isPaidTierKey(tier.key));
  return above.find((tier) => tier.creditsPerMonth >= needed) ?? above[0] ?? null;
}

/** The smallest top up that covers the shortfall, else the largest one. */
export function suggestedTopUp(shortfall: number): TopUp | null {
  const sorted = [...topUps].sort((a, b) => a.credits - b.credits);
  return sorted.find((topUp) => topUp.credits >= shortfall) ?? sorted[sorted.length - 1] ?? null;
}

function balanceSentence(creditBalance: number): string {
  if (creditBalance < 0) {
    return `your balance is ${formatCredits(-creditBalance)} below zero`;
  }
  return creditBalance === 0 ? "you have no credits left" : `you have ${formatCredits(creditBalance)}`;
}

/** The offer paragraphs and links for a workspace that can buy credits. */
function purchaseOffer(plan: string, needed: number, shortfall: number): Pick<PaywallCopy, "paragraphs" | "actions"> {
  const tier = suggestedTier(plan, needed);
  const topUp = suggestedTopUp(shortfall);
  const paragraphs: string[] = [];
  const actions: PaywallAction[] = [];
  if (tier && isPaidTierKey(tier.key)) {
    const name = tierDisplayName(tier.key);
    paragraphs.push(
      `The ${name} plan adds ${formatCredits(tier.creditsPerMonth)} every month for ${formatUsd(tier.monthlyUsd)} a month.`,
    );
    actions.push({
      label: `Upgrade to ${name}`,
      href: billingCheckoutHref({ tier: tier.key, cadence: "monthly" }),
      primary: true,
    });
  }
  if (topUp) {
    paragraphs.push(
      `${tier ? "Or buy" : "Buy"} ${formatCredits(topUp.credits)} once for ${formatUsd(topUp.usd)}. Top up credits stay usable for ${topUpMonths()} months.`,
    );
    actions.push({ label: "Buy credits", href: TOP_UPS_HREF, primary: actions.length === 0 });
  }
  return { paragraphs, actions };
}

/** What a workspace that cannot buy credits right now is told. */
function noPurchaseOffer(context: PaywallContext, fewerChannels: boolean): Pick<PaywallCopy, "paragraphs" | "actions"> {
  if (!context.canBill) {
    return { paragraphs: ["Ask the workspace owner to add credits."], actions: [] };
  }
  const fit = fewerChannels ? "Pick fewer channels to fit your balance, or ask" : "Ask";
  return {
    paragraphs: [
      "Credits are limited during early access, and card payments are not open yet.",
      `${fit} for more credits on the Billing page and we will email you as soon as you can upgrade.`,
    ],
    actions: [{ label: "Open Billing", href: BILLING_HREF, primary: true }],
  };
}

/**
 * The out of credits dialog: shown when createJob refuses a pack because the
 * balance cannot hold its estimate. `needed` is the form's estimate, the
 * same number the server tried to reserve.
 */
export function outOfCreditsCopy(context: PaywallContext, needed: number): PaywallCopy {
  const shortfall = Math.max(needed - Math.max(context.creditBalance, 0), 0);
  const lead = `This pack needs about ${formatCredits(needed)} and ${balanceSentence(context.creditBalance)}.`;
  const offer =
    context.stripeLive && context.canBill
      ? purchaseOffer(context.plan, needed, shortfall)
      : noPurchaseOffer(context, true);
  return {
    title: "Not enough credits for this pack",
    paragraphs: [lead, ...offer.paragraphs],
    actions: offer.actions,
  };
}

/** The low balance nudge, or null when the balance is not low. */
export function lowBalanceCopy(
  context: PaywallContext,
  threshold: number = lowBalanceThreshold(),
): PaywallCopy | null {
  if (!isLowBalance(context.creditBalance, threshold)) {
    return null;
  }
  const out = context.creditBalance === 0;
  const left = out ? "You have no credits left." : `You have ${formatCredits(context.creditBalance)} left.`;
  const lead = `${left} A default listing pack of still images uses about ${formatCredits(threshold)}.`;
  const offer =
    context.stripeLive && context.canBill
      ? purchaseOffer(context.plan, threshold, threshold - context.creditBalance)
      : noPurchaseOffer(context, false);
  return {
    title: out ? "You are out of credits" : "You are running low on credits",
    paragraphs: [lead, ...offer.paragraphs],
    actions: offer.actions,
  };
}

/** The balance in the app header: "40 credits", or a plain word when the
 * balance is below zero, never a bare negative number. */
export function headerBalanceLabel(creditBalance: number): string {
  return creditBalance < 0 ? "Balance below zero" : formatCredits(creditBalance);
}
