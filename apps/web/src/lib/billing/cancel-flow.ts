/**
 * Cancel flow with save offers (docs/PENDING.md, batch 2). When a subscriber
 * clicks Cancel plan on /app/billing they pick a reason, then see up to
 * three save offers (pause billing, a smaller plan, a discount) before they
 * confirm. Offer terms come from the seed (retentionOffers, tiers); only
 * wording lives here. Pure and client safe: the page, the route and the
 * tests share it. The Stripe parameter builders follow the Subscriptions and
 * Coupons API shapes recorded in docs/verification.md (checked 2026-09-28).
 */

import type Stripe from "stripe";
import { retentionOffers, tierByKey, type TierKey } from "@curvi/pipeline/seed";
import {
  formatCredits,
  formatUsd,
  paidTierKeys,
  priceForCadence,
  tierDisplayName,
  type BillingCadence,
  type PaidTierKey,
} from "./plans";

export const CANCEL_REASONS = [
  { key: "too_expensive", label: "It costs too much" },
  { key: "unused", label: "I do not make enough packs to need it" },
  { key: "missing_features", label: "It is missing something I need" },
  { key: "low_quality", label: "The images were not good enough" },
  { key: "too_complex", label: "It is hard to use" },
  { key: "switched_service", label: "I am moving to another tool" },
  { key: "customer_service", label: "I did not get the help I needed" },
  { key: "other", label: "Something else" },
] as const;

export type CancelReason = (typeof CANCEL_REASONS)[number]["key"];

export const CANCEL_REASON_KEYS = CANCEL_REASONS.map((r) => r.key) as [CancelReason, ...CancelReason[]];

export function isCancelReason(value: unknown): value is CancelReason {
  return typeof value === "string" && (CANCEL_REASON_KEYS as string[]).includes(value);
}

/** Longest free text a subscriber can add to their reason. */
export const MAX_CANCEL_DETAIL = 500;

export type SaveOfferKind = "pause" | "downgrade" | "discount";

/** What the flow can end in; "keep" backs out without any change. */
export type CancelChoice = SaveOfferKind | "cancel" | "keep";

export type CancelOutcome = "paused" | "downgraded" | "discounted" | "canceled" | "kept";

export function outcomeForChoice(choice: CancelChoice): CancelOutcome {
  switch (choice) {
    case "pause":
      return "paused";
    case "downgrade":
      return "downgraded";
    case "discount":
      return "discounted";
    case "cancel":
      return "canceled";
    case "keep":
      return "kept";
  }
}

export interface SaveOffer {
  kind: SaveOfferKind;
  title: string;
  body: string;
  action: string;
  /** The smaller plan, for a downgrade. */
  toTier?: PaidTierKey;
}

export interface OfferContext {
  tier: PaidTierKey;
  /** Null when the billing cadence is unknown (no Stripe subscription). */
  cadence: BillingCadence | null;
  /** Save offers this workspace already took (outcomes paused, discounted). */
  usedOffers: ReadonlySet<SaveOfferKind>;
  /** The subscription already carries a discount. */
  hasDiscount: boolean;
}

/** The paid tier just below this one, or null on the smallest plan. */
export function downgradeTarget(tier: PaidTierKey): PaidTierKey | null {
  const index = paidTierKeys.indexOf(tier);
  return index > 0 ? paidTierKeys[index - 1] : null;
}

/** Two decimals only when there are cents: $55.30, $79. */
export function formatPrice(amount: number): string {
  const cents = Math.round(amount * 100);
  return cents % 100 === 0 ? formatUsd(cents / 100) : `$${(cents / 100).toFixed(2)}`;
}

function months(n: number): string {
  return `${n === 1 ? "one" : n} ${n === 1 ? "month" : "months"}`;
}

/** Offer order by reason: the offer most likely to answer it comes first. */
export function offerOrderFor(reason: CancelReason): SaveOfferKind[] {
  switch (reason) {
    case "too_expensive":
      return ["discount", "downgrade", "pause"];
    case "unused":
      return ["pause", "downgrade", "discount"];
    default:
      return ["discount", "pause", "downgrade"];
  }
}

/**
 * The save offers this subscriber may take, each once per workspace
 * (retentionOffers.oncePerWorkspace) for pause and discount. Pause and
 * discount are monthly plan offers: an annual plan pays once a year, so a
 * month's pause or a few months' discount would not change its bill. A
 * discount is never stacked on a subscription that already has one.
 */
export function eligibleOffers(ctx: OfferContext): SaveOffer[] {
  const offers: SaveOffer[] = [];
  const tier = tierByKey(ctx.tier);
  const cadence = ctx.cadence ?? "monthly";
  const monthly = ctx.cadence !== "annual";
  const once = retentionOffers.oncePerWorkspace;

  if (monthly && !(once && ctx.usedOffers.has("pause"))) {
    const n = retentionOffers.pauseMonths;
    offers.push({
      kind: "pause",
      title: `Pause billing for ${months(n)}`,
      body: `No charge for ${months(n)}. You keep your plan and the credits you have, and billing starts again on its own. No new credits arrive while billing is paused.`,
      action: `Pause for ${months(n)}`,
    });
  }

  const target = downgradeTarget(ctx.tier);
  if (target) {
    const lower = tierByKey(target);
    const price = priceForCadence(lower, cadence);
    offers.push({
      kind: "downgrade",
      toTier: target,
      title: `Switch to ${tierDisplayName(target)} for ${formatPrice(price.perMonthUsd)} a month`,
      body: `${formatCredits(lower.creditsPerMonth)} a month instead of ${formatCredits(tier.creditsPerMonth)}. The smaller plan starts now with no extra charge, and your next bill is ${formatPrice(price.billedUsd)}. Credits you already have stay.`,
      action: `Switch to ${tierDisplayName(target)}`,
    });
  }

  if (monthly && !ctx.hasDiscount && !(once && ctx.usedOffers.has("discount"))) {
    const { percentOff, months: discountMonths } = retentionOffers.discount;
    const discounted = (tier.monthlyUsd * (100 - percentOff)) / 100;
    offers.push({
      kind: "discount",
      title: `${percentOff} percent off for ${months(discountMonths)}`,
      body: `Your next ${months(discountMonths)} of ${tierDisplayName(ctx.tier)} cost ${formatPrice(discounted)} a month instead of ${formatPrice(tier.monthlyUsd)}, with the same credits. After that the regular price applies.`,
      action: `Take ${percentOff} percent off`,
    });
  }
  return offers;
}

/** eligibleOffers in the order that fits the reason. */
export function offersForReason(offers: SaveOffer[], reason: CancelReason): SaveOffer[] {
  const order = offerOrderFor(reason);
  return [...offers].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

/** Adds whole calendar months in UTC, clamping to the month's last day. */
export function addMonths(date: Date, count: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + count);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

const toUnix = (date: Date): number => Math.floor(date.getTime() / 1000);

/**
 * Pause payment collection until resumes_at. "void" voids the invoices of
 * the paused period, so nothing is charged and, since credits are granted on
 * paid invoices, no renewal credits arrive (Stripe "Pause payment
 * collection"). The status stays active.
 */
export function buildPauseParams(now: Date, pauseMonths: number = retentionOffers.pauseMonths) {
  const resumesAt = addMonths(now, pauseMonths);
  const params = {
    pause_collection: { behavior: "void", resumes_at: toUnix(resumesAt) },
  } satisfies Stripe.SubscriptionUpdateParams;
  return { params, resumesAt };
}

/** Moves the subscription's single item to the smaller plan's price with no
 * proration: no refund and no charge now, the next invoice bills the new
 * price. The metadata plan follows so the webhook and the dashboard agree. */
export function buildDowngradeParams(input: {
  itemId: string;
  priceId: string;
  toTier: PaidTierKey;
}): Stripe.SubscriptionUpdateParams {
  return {
    items: [{ id: input.itemId, price: input.priceId, quantity: 1 }],
    proration_behavior: "none",
    metadata: { plan: input.toTier },
  };
}

/** Replaces the subscription's discounts with the save offer coupon. */
export function buildDiscountParams(couponId: string): Stripe.SubscriptionUpdateParams {
  return { discounts: [{ coupon: couponId }] };
}

/** Stripe's cancellation feedback for each reason (the values match). */
export function stripeFeedbackFor(reason: CancelReason): Stripe.SubscriptionUpdateParams.CancellationDetails.Feedback {
  return reason;
}

/** Cancels at the end of the paid period, with the reason on Stripe too. */
export function buildCancelParams(reason: CancelReason, detail: string | null): Stripe.SubscriptionUpdateParams {
  return {
    cancel_at_period_end: true,
    cancellation_details: {
      feedback: stripeFeedbackFor(reason),
      ...(detail ? { comment: detail.slice(0, MAX_CANCEL_DETAIL) } : {}),
    },
  };
}

/**
 * The save offer coupon. Its id is derived from the seed terms, so the route
 * can look it up and create it on first use, and a change of terms makes a
 * new coupon instead of silently reusing the old one.
 */
export function retentionCoupon(): { id: string; params: Stripe.CouponCreateParams } {
  const { percentOff, months: discountMonths } = retentionOffers.discount;
  const id = `curvi_save_${percentOff}pct_${discountMonths}mo`;
  return {
    id,
    params: {
      id,
      percent_off: percentOff,
      duration: "repeating",
      duration_in_months: discountMonths,
      name: `Save offer ${percentOff} percent off`,
      metadata: { source: "cancel_flow" },
    },
  };
}

/** The confirmation the flow shows after each outcome. */
export function outcomeNotice(input: {
  outcome: CancelOutcome;
  stripeApplied: boolean;
  effectiveAt: Date | null;
  toTier?: TierKey | null;
}): string {
  const date = input.effectiveAt
    ? input.effectiveAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })
    : null;
  if (!input.stripeApplied && input.outcome !== "kept") {
    return "Thanks, we saved your choice. Card payments are not open yet, so nothing is charged or changed today, and we will email you to confirm.";
  }
  switch (input.outcome) {
    case "paused":
      return date
        ? `Billing is paused until ${date}. Your plan and credits stay as they are.`
        : "Billing is paused. Your plan and credits stay as they are.";
    case "downgraded":
      return `You are now on ${tierDisplayName(input.toTier ?? "starter")}. Your next bill is at the new price.`;
    case "discounted":
      return `The discount is on. Your next ${months(retentionOffers.discount.months)} cost ${retentionOffers.discount.percentOff} percent less.`;
    case "canceled":
      return date
        ? `Your plan is canceled. It stays active until ${date}, then your workspace moves to the Free plan.`
        : "Your plan is canceled. It stays active until the end of the period you paid for, then your workspace moves to the Free plan.";
    case "kept":
      return "Good to have you. Nothing changed.";
  }
}
