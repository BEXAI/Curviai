/**
 * Server side of the cancel flow: which save offers a workspace may take,
 * and applying the subscriber's choice. With Stripe configured and an open
 * Stripe subscription, the choice is written to Stripe (pause_collection, a
 * price change, a coupon, or cancel at period end) and the webhook then
 * syncs the plan as for any other subscription change. Without Stripe, or
 * without a Stripe subscription, the flow still shows and records the
 * reason and outcome, and nothing is charged or changed. Every pass is
 * recorded in cancel_flows (migration 0018). Dependencies are injected so
 * the route logic is unit tested without Stripe or a database.
 */

import type Stripe from "stripe";
import type { NewCancelFlow } from "@curvi/db";
import { isStripeMissingResource } from "./stripe";
import type { PriceTable } from "./price-table";
import {
  buildCancelParams,
  buildDiscountParams,
  buildDowngradeParams,
  buildPauseParams,
  CANCEL_REASONS,
  eligibleOffers,
  outcomeForChoice,
  outcomeNotice,
  retentionCoupon,
  type CancelChoice,
  type CancelOutcome,
  type CancelReason,
  type SaveOffer,
  type SaveOfferKind,
} from "./cancel-flow";
import { isPaidTierKey, type BillingCadence, type PaidTierKey } from "./plans";
import type { BillingAccount } from "./account";
import { isOpenSubscription } from "./subscription-status";

/** What earlier passes through the flow left behind. */
export interface CancelState {
  /** Save offers already taken (each is offered once per workspace). */
  usedOffers: Set<SaveOfferKind>;
  /** A pause or cancellation that is still ahead, shown instead of the button. */
  pending: { outcome: "paused" | "canceled"; effectiveAt: string } | null;
}

export interface CancelDeps {
  /** Null when Stripe has no keys. */
  stripe: Stripe | null;
  priceTable: PriceTable;
  priceIdFor(tier: PaidTierKey, cadence: BillingCadence): string | undefined;
  now(): Date;
  loadState(workspaceId: string): Promise<CancelState>;
  record(row: NewCancelFlow): Promise<void>;
}

export interface CancelWorkspace {
  id: string;
  plan: string;
}

/** The Stripe subscription facts the flow needs. */
export interface SubscriptionFacts {
  subscriptionId: string;
  itemId: string | null;
  cadence: BillingCadence | null;
  hasDiscount: boolean;
  cancelAtPeriodEnd: boolean;
  paused: boolean;
  periodEnd: Date | null;
}

export interface CancelOptions {
  tier: PaidTierKey;
  reasons: typeof CANCEL_REASONS;
  offers: SaveOffer[];
  /** False when the choice is only recorded (no Stripe subscription to change). */
  live: boolean;
  periodEnd: string | null;
}

export type CancelResult =
  | { ok: true; status: 200; outcome: CancelOutcome; notice: string; stripeApplied: boolean; effectiveAt: string | null }
  | { ok: false; status: number; error: string; notice: string };

/** Stripe calls in this flow give up after this long and retry once. */
const STRIPE_OPTIONS = { timeout: 15_000, maxNetworkRetries: 1 } as const satisfies Stripe.RequestOptions;

export type CancelFailure = Extract<CancelResult, { ok: false }>;

function fail(status: number, error: string, notice: string): CancelFailure {
  return { ok: false, status, error, notice };
}

/** Records a pass. A failed write is logged, never shown: by then Stripe may
 * already hold the change, and the subscriber must hear that it worked. */
async function safeRecord(deps: CancelDeps, row: NewCancelFlow): Promise<void> {
  try {
    await deps.record(row);
  } catch (error) {
    console.error(JSON.stringify({ msg: "billing: cancel flow record failed", workspaceId: row.workspaceId, error: String(error) }));
  }
}

/** Reads the subscription from Stripe. Null when it no longer exists. */
export async function readSubscriptionFacts(
  stripe: Stripe,
  subscriptionId: string,
  table: PriceTable,
): Promise<SubscriptionFacts | null> {
  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(subscriptionId, {}, STRIPE_OPTIONS);
  } catch (error) {
    if (isStripeMissingResource(error)) {
      return null;
    }
    throw error;
  }
  const items = subscription.items?.data ?? [];
  const item = items.length === 1 ? items[0] : null;
  const mapping = item?.price?.id ? table[item.price.id] : undefined;
  return {
    subscriptionId: subscription.id,
    itemId: item?.id ?? null,
    cadence: mapping?.kind === "tier" ? mapping.cadence : null,
    hasDiscount: (subscription.discounts ?? []).length > 0,
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
    paused: subscription.pause_collection !== null && subscription.pause_collection !== undefined,
    periodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000) : null,
  };
}

/** The paid plan the flow is about, or null on Free. */
export function cancelTier(workspace: CancelWorkspace, account: BillingAccount): PaidTierKey | null {
  const subscribed = account.subscription?.tier;
  if (isOpenSubscription(account.subscription?.status) && isPaidTierKey(subscribed)) {
    return subscribed;
  }
  return isPaidTierKey(workspace.plan) ? workspace.plan : null;
}

interface Resolved {
  tier: PaidTierKey;
  facts: SubscriptionFacts | null;
  state: CancelState;
  offers: SaveOffer[];
}

async function resolve(
  deps: CancelDeps,
  workspace: CancelWorkspace,
  account: BillingAccount,
): Promise<Resolved | CancelFailure> {
  const tier = cancelTier(workspace, account);
  if (!tier) {
    return fail(409, "no_plan", "You are on the Free plan, so there is no plan to cancel.");
  }
  const state = await deps.loadState(workspace.id);
  if (state.pending) {
    return fail(
      409,
      "already_pending",
      state.pending.outcome === "canceled"
        ? "Your plan is already set to end. Open the customer portal to renew it."
        : "Billing is already paused. It starts again on its own.",
    );
  }
  let facts: SubscriptionFacts | null = null;
  const subscriptionId = account.subscription?.externalId;
  if (deps.stripe && subscriptionId && isOpenSubscription(account.subscription?.status)) {
    try {
      facts = await readSubscriptionFacts(deps.stripe, subscriptionId, deps.priceTable);
    } catch (error) {
      console.error(JSON.stringify({ msg: "billing: cancel flow lookup failed", workspaceId: workspace.id, error: String(error) }));
      return fail(502, "stripe_error", "Stripe could not be reached just now. Try again in a minute.");
    }
    if (facts?.cancelAtPeriodEnd) {
      return fail(409, "already_pending", "Your plan is already set to end. Open the customer portal to renew it.");
    }
    if (facts?.paused) {
      return fail(409, "already_pending", "Billing is already paused. It starts again on its own.");
    }
  }
  const offers = eligibleOffers({
    tier,
    cadence: facts?.cadence ?? null,
    usedOffers: state.usedOffers,
    hasDiscount: facts?.hasDiscount ?? false,
  });
  return { tier, facts, state, offers };
}

export async function cancelOptions(
  deps: CancelDeps,
  workspace: CancelWorkspace,
  account: BillingAccount,
): Promise<{ ok: true; options: CancelOptions } | CancelFailure> {
  const resolved = await resolve(deps, workspace, account);
  if ("status" in resolved) {
    return resolved;
  }
  return {
    ok: true,
    options: {
      tier: resolved.tier,
      reasons: CANCEL_REASONS,
      offers: resolved.offers,
      live: resolved.facts !== null,
      periodEnd: resolved.facts?.periodEnd?.toISOString() ?? account.subscription?.periodEnd ?? null,
    },
  };
}

/** Finds the save offer coupon, creating it from the seed terms on first use. */
async function ensureRetentionCoupon(stripe: Stripe): Promise<string> {
  const coupon = retentionCoupon();
  try {
    const existing = await stripe.coupons.retrieve(coupon.id, {}, STRIPE_OPTIONS);
    if (!existing.valid) {
      // Expired or deleted in the Dashboard: never apply it, and never
      // quietly make another under a new id.
      throw new Error(`save offer coupon ${coupon.id} is no longer valid`);
    }
    return existing.id;
  } catch (error) {
    if (!isStripeMissingResource(error)) {
      throw error;
    }
  }
  try {
    // The fixed id makes the create itself idempotent: a second create for
    // the same id fails with resource_already_exists instead of duplicating.
    const created = await stripe.coupons.create(coupon.params, STRIPE_OPTIONS);
    return created.id;
  } catch (error) {
    if ((error as { code?: unknown })?.code === "resource_already_exists") {
      return coupon.id;
    }
    throw error;
  }
}

export interface CancelChoiceInput {
  workspace: CancelWorkspace;
  account: BillingAccount;
  userId: string | null;
  reason: CancelReason;
  detail: string | null;
  choice: CancelChoice;
}

export async function applyCancelChoice(deps: CancelDeps, input: CancelChoiceInput): Promise<CancelResult> {
  const { workspace, account, reason, choice } = input;
  const detail = input.detail?.trim() ? input.detail.trim() : null;
  const resolved = await resolve(deps, workspace, account);
  if ("status" in resolved) {
    return resolved;
  }
  const { tier, facts, offers } = resolved;
  const offer = offers.find((o) => o.kind === choice);
  if ((choice === "pause" || choice === "downgrade" || choice === "discount") && !offer) {
    return fail(409, "offer_unavailable", "That offer is not available for your plan. Pick another option.");
  }
  const outcome = outcomeForChoice(choice);
  const toTier = choice === "downgrade" ? (offer?.toTier ?? null) : null;
  const now = deps.now();
  const row: NewCancelFlow = {
    workspaceId: workspace.id,
    userId: input.userId,
    reason,
    detail,
    fromTier: tier,
    toTier,
    offersShown: offers.map((o) => o.kind),
    outcome,
    stripeApplied: false,
    stripeSubscriptionId: facts?.subscriptionId ?? null,
    effectiveAt: null,
  };

  if (deps.stripe && facts && choice !== "keep") {
    const stripe = deps.stripe;
    try {
      switch (choice) {
        case "pause": {
          const { params, resumesAt } = buildPauseParams(now);
          await stripe.subscriptions.update(facts.subscriptionId, params, STRIPE_OPTIONS);
          row.effectiveAt = resumesAt;
          break;
        }
        case "downgrade": {
          const priceId = toTier ? deps.priceIdFor(toTier, facts.cadence ?? "monthly") : undefined;
          if (!toTier || !priceId || !facts.itemId) {
            await safeRecord(deps, { ...row, error: "downgrade price or subscription item missing" });
            return fail(503, "plan_unavailable", "That plan cannot be picked online right now. Email hello@curvi.ai and we will switch it for you.");
          }
          await stripe.subscriptions.update(
            facts.subscriptionId,
            buildDowngradeParams({ itemId: facts.itemId, priceId, toTier }),
            STRIPE_OPTIONS,
          );
          break;
        }
        case "discount": {
          const couponId = await ensureRetentionCoupon(stripe);
          await stripe.subscriptions.update(facts.subscriptionId, buildDiscountParams(couponId), STRIPE_OPTIONS);
          break;
        }
        case "cancel": {
          const updated = await stripe.subscriptions.update(
            facts.subscriptionId,
            buildCancelParams(reason, detail),
            STRIPE_OPTIONS,
          );
          const periodEnd = updated.items?.data?.[0]?.current_period_end;
          row.effectiveAt = periodEnd ? new Date(periodEnd * 1000) : facts.periodEnd;
          break;
        }
      }
      row.stripeApplied = true;
    } catch (error) {
      console.error(
        JSON.stringify({ msg: "billing: cancel flow update failed", workspaceId: workspace.id, choice, error: String(error) }),
      );
      await safeRecord(deps, { ...row, error: String(error).slice(0, 500) });
      return fail(502, "stripe_error", "Stripe could not make that change just now. Nothing changed. Try again in a minute.");
    }
  } else if (choice === "cancel") {
    const periodEnd = account.subscription?.periodEnd;
    row.effectiveAt = periodEnd ? new Date(periodEnd) : null;
  }

  await safeRecord(deps, row);
  const effectiveAt = row.effectiveAt instanceof Date ? row.effectiveAt : null;
  return {
    ok: true,
    status: 200,
    outcome,
    stripeApplied: row.stripeApplied === true,
    effectiveAt: effectiveAt?.toISOString() ?? null,
    notice: outcomeNotice({ outcome, stripeApplied: row.stripeApplied === true, effectiveAt, toTier }),
  };
}
