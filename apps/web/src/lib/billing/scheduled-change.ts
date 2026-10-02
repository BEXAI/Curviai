import type Stripe from "stripe";
import { and, eq, subscriptions, type Db } from "@curvi/db";
import { isSelfServeTierKey, planChangeDirection, type PlanPrice } from "./plans";
import type { PriceTable } from "./price-table";
import { STRIPE_LOOKUP_OPTIONS } from "./stripe";

export const CLEAR_PENDING_CHANGE = { pendingTier: null, pendingCadence: null, pendingAt: null, pendingScheduleId: null } as const;

export class ScheduledChangeError extends Error {}

const objectId = (value: string | { id: string } | null | undefined): string | undefined =>
  typeof value === "string" ? value : value?.id;

function copyDiscounts(discounts: Stripe.SubscriptionSchedule.Phase.Discount[] = []) {
  return discounts.map((discount) => {
    const existing = objectId(discount.discount);
    const promotion = objectId(discount.promotion_code);
    return existing ? { discount: existing } : promotion ? { promotion_code: promotion } : { coupon: objectId(discount.coupon) };
  });
}

/** Keep the current price, discounts and metadata intact until its period ends. */
export function currentSchedulePhase(phase: Stripe.SubscriptionSchedule.Phase): Stripe.SubscriptionScheduleUpdateParams.Phase {
  return {
    start_date: phase.start_date, end_date: phase.end_date, proration_behavior: "none",
    items: phase.items.map((item) => ({
      price: objectId(item.price), quantity: item.quantity,
      discounts: copyDiscounts(item.discounts), metadata: item.metadata ?? {},
      tax_rates: item.tax_rates?.map((rate) => rate.id),
    })),
    discounts: copyDiscounts(phase.discounts), metadata: phase.metadata ?? {},
    ...(phase.automatic_tax ? { automatic_tax: { enabled: phase.automatic_tax.enabled } } : {}),
    ...(phase.default_tax_rates ? { default_tax_rates: phase.default_tax_rates.map((rate) => rate.id) } : {}),
    ...(phase.default_payment_method ? { default_payment_method: objectId(phase.default_payment_method) } : {}),
    ...(phase.collection_method ? { collection_method: phase.collection_method } : {}),
    ...(phase.description ? { description: phase.description } : {}),
  };
}

/** The caller serializes workspace changes. No ledger write happens here. */
export async function scheduleDowngrade(stripe: Stripe, input: {
  subscriptionId: string; customerId: string; targetPriceId: string; target: PlanPrice;
  prices: PriceTable; pendingScheduleId?: string | null;
}): Promise<{ scheduleId: string; startsAt: Date }> {
  if (input.pendingScheduleId) throw new ScheduledChangeError("Keep your current plan before choosing another scheduled change.");
  const subscription = await stripe.subscriptions.retrieve(input.subscriptionId, {}, STRIPE_LOOKUP_OPTIONS);
  if (objectId(subscription.customer) !== input.customerId) throw new ScheduledChangeError("The subscription does not belong to this workspace.");
  if (subscription.status !== "active" || subscription.cancel_at_period_end || subscription.pause_collection) {
    throw new ScheduledChangeError("Resume your active plan before scheduling a change.");
  }
  if (subscription.schedule) throw new ScheduledChangeError("Keep your current plan before choosing another scheduled change.");
  const item = subscription.items.data[0];
  const current = item ? input.prices[item.price.id] : null;
  const target = input.prices[input.targetPriceId];
  if (subscription.items.data.length !== 1 || item?.quantity !== 1 || current?.kind !== "tier" ||
    !isSelfServeTierKey(current.tier) || !isSelfServeTierKey(input.target.tier) || target?.kind !== "tier" ||
    target.tier !== input.target.tier || target.cadence !== input.target.cadence ||
    planChangeDirection({ tier: current.tier, cadence: current.cadence }, input.target) !== "downgrade") {
    throw new ScheduledChangeError("This plan change cannot be scheduled online.");
  }
  const schedule = await stripe.subscriptionSchedules.create({ from_subscription: subscription.id }, STRIPE_LOOKUP_OPTIONS);
  try {
    const phase = schedule.phases.find((entry) => entry.start_date === schedule.current_phase?.start_date) ?? schedule.phases[0];
    if (!phase || phase.end_date !== item.current_period_end) throw new Error("The schedule does not match the current billing period.");
    const copied = currentSchedulePhase(phase);
    await stripe.subscriptionSchedules.update(schedule.id, {
      end_behavior: "release", proration_behavior: "none",
      phases: [copied, {
        ...copied, start_date: phase.end_date, end_date: undefined,
        duration: { interval: input.target.cadence === "annual" ? "year" : "month", interval_count: 1 },
        items: [{ price: input.targetPriceId, quantity: 1 }],
        proration_behavior: "none",
      }],
    }, STRIPE_LOOKUP_OPTIONS);
    return { scheduleId: schedule.id, startsAt: new Date(phase.end_date * 1000) };
  } catch (error) {
    // Do not leave an empty schedule attached after an update failure.
    await stripe.subscriptionSchedules.release(schedule.id, {}, STRIPE_LOOKUP_OPTIONS);
    throw error;
  }
}

/** Matching the id prevents a late release event from removing a newer change. */
export async function clearPendingChange(db: Db, scheduleId: string, workspaceId?: string): Promise<void> {
  await db.update(subscriptions).set(CLEAR_PENDING_CHANGE).where(and(
    eq(subscriptions.pendingScheduleId, scheduleId),
    ...(workspaceId ? [eq(subscriptions.workspaceId, workspaceId)] : []),
  ));
}

export async function keepCurrentPlan(stripe: Stripe, input: {
  subscriptionId: string; customerId: string; scheduleId: string;
}): Promise<void> {
  const subscription = await stripe.subscriptions.retrieve(input.subscriptionId, {}, STRIPE_LOOKUP_OPTIONS);
  if (objectId(subscription.customer) !== input.customerId || objectId(subscription.schedule) !== input.scheduleId) {
    throw new ScheduledChangeError("That scheduled change is no longer attached to this plan. Refresh Billing to see its latest state.");
  }
  await stripe.subscriptionSchedules.release(input.scheduleId, {}, STRIPE_LOOKUP_OPTIONS);
}

/** Reconcile an attachment after a timeout/process interruption. This reads
 * Stripe, then only repairs our pending display; it never changes Stripe.
 * The caller holds the workspace checkout lock. Unknown/empty schedules
 * retain their id so Keep current plan remains available. */
export async function recoverPendingSchedule(db: Db, stripe: Stripe, input: {
  workspaceId: string; subscriptionId: string; customerId: string; prices: PriceTable;
}, now = new Date()): Promise<{ scheduleId: string; startsAt: Date | null; target: PlanPrice | null } | null> {
  const sub = await stripe.subscriptions.retrieve(input.subscriptionId, {}, STRIPE_LOOKUP_OPTIONS);
  if (objectId(sub.customer) !== input.customerId) throw new ScheduledChangeError("The subscription does not belong to this workspace.");
  const scheduleId = objectId(sub.schedule);
  const scope = and(eq(subscriptions.workspaceId, input.workspaceId), eq(subscriptions.externalId, input.subscriptionId));
  if (!scheduleId) { await db.update(subscriptions).set(CLEAR_PENDING_CHANGE).where(scope); return null; }
  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId, {}, STRIPE_LOOKUP_OPTIONS);
  if (objectId(schedule.customer) !== input.customerId || objectId(schedule.subscription) !== input.subscriptionId) {
    throw new ScheduledChangeError("The schedule does not belong to this subscription.");
  }
  const future = schedule.phases.filter((p) => p.start_date > now.getTime() / 1000).sort((a, b) => a.start_date - b.start_date)[0];
  const price = future?.items.length === 1 && future.items[0].quantity === 1 ? objectId(future.items[0].price) : undefined;
  const mapped = price ? input.prices[price] : null;
  const target: PlanPrice | null = mapped?.kind === "tier" && isSelfServeTierKey(mapped.tier) ? { tier: mapped.tier, cadence: mapped.cadence } : null;
  const startsAt = future ? new Date(future.start_date * 1000) : null;
  await db.update(subscriptions).set(target && startsAt ? {
    pendingTier: target.tier, pendingCadence: target.cadence, pendingAt: startsAt, pendingScheduleId: scheduleId,
  } : CLEAR_PENDING_CHANGE).where(scope);
  return { scheduleId, startsAt, target };
}

/** Save only after Stripe accepts both phases; undo the attachment if persistence fails. */
export async function scheduleWorkspaceDowngrade(db: Db, stripe: Stripe, input: Parameters<typeof scheduleDowngrade>[1] & { workspaceId: string }) {
  const recovered = await recoverPendingSchedule(db, stripe, input);
  if (recovered) {
    if (!input.pendingScheduleId && recovered.target?.tier === input.target.tier && recovered.target.cadence === input.target.cadence && recovered.startsAt) {
      return { scheduleId: recovered.scheduleId, startsAt: recovered.startsAt };
    }
    throw new ScheduledChangeError("Keep your current plan before choosing another scheduled change.");
  }
  const change = await scheduleDowngrade(stripe, { ...input, pendingScheduleId: null });
  try {
    const saved = await db.update(subscriptions).set({
      pendingTier: input.target.tier, pendingCadence: input.target.cadence, pendingAt: change.startsAt, pendingScheduleId: change.scheduleId,
    }).where(and(eq(subscriptions.workspaceId, input.workspaceId), eq(subscriptions.externalId, input.subscriptionId))).returning({ id: subscriptions.id });
    if (saved.length !== 1) throw new Error("Subscription changed while scheduling.");
  } catch (error) {
    await stripe.subscriptionSchedules.release(change.scheduleId, {}, STRIPE_LOOKUP_OPTIONS);
    throw error;
  }
  return change;
}
