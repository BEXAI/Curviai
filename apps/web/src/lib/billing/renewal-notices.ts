import type Stripe from "stripe";
import { sql, type Db } from "@curvi/db";
import { billingNoticePolicy, renewalNotices } from "@curvi/pipeline/seed";
import { optionalEnv, siteUrl } from "@/lib/env";
import { LEGAL_FACTS } from "@/lib/legal/facts";
import { billingTransactionalSender } from "./transactional-email";
import { isBillingCadence, isPaidTierKey, tierDisplayName, type BillingCadence, type PaidTierKey } from "./plans";
import { formatRenewalDate } from "./renewal-terms";
import { buildPriceTable, type PriceTable } from "./price-table";
import { STRIPE_LOOKUP_OPTIONS } from "./stripe";

const DAY = 86_400_000;
export interface NoticeSubscription {
  id: string; externalId: string | null; workspaceId: string; customerId: string; tier: PaidTierKey; cadence: BillingCadence;
  periodEnd: Date; createdAt: Date; cancelAtPeriodEnd: boolean;
}
export interface BillingNotice { key: string; subject: string; text: string }
export interface RenewalQuote { tier: PaidTierKey; cadence: BillingCadence; priceCents: number }

function footer(url: string): string {
  return `Cancel any time in Billing: ${url}/app/billing\n\nQuestions? Reply to this email or write to ${LEGAL_FACTS.support.email}.`;
}

export function renewalNoticeDue(subscription: NoticeSubscription, now: Date): boolean {
  if (subscription.cancelAtPeriodEnd || subscription.periodEnd <= now) return false;
  const days = Math.ceil((subscription.periodEnd.getTime() - now.getTime()) / DAY);
  const annual = subscription.cadence === "annual";
  if (annual) {
    const [min, max] = renewalNotices.annualWindow;
    if (days < min || days > max) return false;
  } else {
    if (!renewalNotices.monthlyYearlyNotice || now.getUTCFullYear() <= subscription.createdAt.getUTCFullYear() ||
      now.getUTCMonth() !== subscription.createdAt.getUTCMonth()) return false;
  }
  return true;
}

/** Eligibility follows the current term; copy quotes the verified next term. */
export function renewalNotice(subscription: NoticeSubscription, now: Date, url: string, quote: RenewalQuote): BillingNotice | null {
  if (!renewalNoticeDue(subscription, now)) return null;
  const annual = subscription.cadence === "annual";
  const date = formatRenewalDate(subscription.periodEnd);
  const period = quote.cadence === "annual" ? "year" : "month";
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(quote.priceCents / 100);
  return {
    key: annual ? `renewal_notice:${subscription.id}:${subscription.periodEnd.toISOString()}` : `yearly_notice:${subscription.id}:${now.getUTCFullYear()}`,
    subject: annual ? `Your Curvi plan renews on ${date}` : "A yearly note about your Curvi plan",
    text: `At your next renewal on ${date}, your Curvi plan will be ${tierDisplayName(quote.tier)}, billed every ${period} at ${amount} plus any tax that applies, less any discount that still applies. It renews automatically until you cancel.\n\nTo avoid the next charge, cancel before that date. You keep your plan until the end of the period you paid for. There is no minimum term.\n\n${footer(url)}`,
  };
}

const objectId = (value: string | { id: string } | null | undefined) => typeof value === "string" ? value : value?.id;
const uncertain = () => new Error("The next renewal terms could not be verified. Retry after checking Stripe.");

async function verifiedPrice(stripe: Stripe, price: string | Stripe.Price | Stripe.DeletedPrice, prices: PriceTable): Promise<RenewalQuote> {
  const priceId = objectId(price);
  if (!priceId) throw uncertain();
  const mapping = prices[priceId];
  if (mapping?.kind !== "tier" || !isPaidTierKey(mapping.tier)) throw uncertain();
  const resolved = typeof price === "string" ? await stripe.prices.retrieve(price, {}, STRIPE_LOOKUP_OPTIONS) : price;
  if (resolved.deleted) throw uncertain();
  if (resolved.id !== priceId || resolved.currency !== "usd" || resolved.billing_scheme !== "per_unit" ||
    resolved.recurring?.usage_type !== "licensed" || resolved.recurring.interval_count !== 1 ||
    resolved.recurring.interval !== (mapping.cadence === "annual" ? "year" : "month") || !Number.isSafeInteger(resolved.unit_amount) || resolved.unit_amount! <= 0) throw uncertain();
  return { tier: mapping.tier, cadence: mapping.cadence, priceCents: resolved.unit_amount! };
}

/** Read-only: pending DB fields can lag an accepted Stripe request. Never
 * use them, the current DB tier, or the catalog amount as proof of renewal. */
export async function verifiedRenewalTerms(stripe: Stripe, stored: NoticeSubscription, prices: PriceTable, now: Date): Promise<{ subscription: NoticeSubscription; quote: RenewalQuote } | null> {
  if (!stored.externalId) throw uncertain();
  const live = await stripe.subscriptions.retrieve(stored.externalId, {}, STRIPE_LOOKUP_OPTIONS);
  if (live.id !== stored.externalId || objectId(live.customer) !== stored.customerId) throw uncertain();
  if (live.status !== "active" || live.cancel_at_period_end || live.pause_collection) return null;
  const current = live.items.data[0];
  if (live.items.data.length !== 1 || current?.quantity !== 1) throw uncertain();
  const boundary = current.current_period_end;
  if (!Number.isSafeInteger(boundary) || boundary * 1000 <= now.getTime()) throw uncertain();
  if (live.cancel_at && live.cancel_at <= boundary) return null;
  const currentQuote = await verifiedPrice(stripe, current.price, prices);
  let price: string | Stripe.Price | Stripe.DeletedPrice = current.price;
  const scheduleId = objectId(live.schedule);
  if (scheduleId) {
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId, {}, STRIPE_LOOKUP_OPTIONS);
    if (schedule.id !== scheduleId || schedule.status !== "active" || objectId(schedule.customer) !== stored.customerId || objectId(schedule.subscription) !== live.id) throw uncertain();
    // An earlier phase transition can reset the billing anchor and charge
    // before current_period_end. Do not claim the old date still applies.
    if (schedule.phases.some((phase) => phase.start_date > now.getTime() / 1000 && phase.start_date < boundary)) throw uncertain();
    const phases = schedule.phases.filter((phase) => phase.start_date <= boundary && phase.end_date > boundary);
    // A released final phase keeps its price; a canceled final phase does
    // not renew. More complex future changes cannot be described by this
    // simple recurring-price notice and fail closed for operator review.
    const last = schedule.phases.at(-1);
    if (phases.length === 0 && last?.end_date === boundary && schedule.end_behavior === "cancel") return null;
    const phase = phases.length === 1 ? phases[0] : phases.length === 0 && last?.end_date === boundary && schedule.end_behavior === "release" ? last : null;
    if (schedule.end_behavior !== "release" || !phase || phase !== last || phase.items.length !== 1 || phase.items[0].quantity !== 1 || (phase.trial_end && phase.trial_end > boundary)) throw uncertain();
    price = phase.items[0].price;
  }
  return {
    subscription: { ...stored, tier: currentQuote.tier, cadence: currentQuote.cadence, periodEnd: new Date(boundary * 1000), cancelAtPeriodEnd: false },
    quote: scheduleId ? await verifiedPrice(stripe, price, prices) : currentQuote,
  };
}

export function validatePriceNotice(input: { newUsd: number; effective: Date }, now: Date): void {
  const days = (input.effective.getTime() - now.getTime()) / DAY;
  const [min, max] = renewalNotices.priceChangeWindow;
  if (!Number.isFinite(input.newUsd) || input.newUsd <= 0 || !Number.isFinite(days) || days < min || days > max) {
    throw new Error(`Use a positive price and an effective date ${min} to ${max} days from now.`);
  }
}

export function priceNotice(subscription: NoticeSubscription, input: { newUsd: number; effective: Date }, url: string): BillingNotice {
  const date = formatRenewalDate(input.effective);
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(input.newUsd);
  return {
    key: `price_notice:${subscription.id}:${input.effective.toISOString().slice(0, 10)}:${Math.round(input.newUsd * 100)}`,
    subject: `Your Curvi plan price changes on ${date}`,
    text: `Your Curvi ${tierDisplayName(subscription.tier)} plan price changes to ${amount} per ${subscription.cadence === "annual" ? "year" : "month"}, plus any tax that applies, on ${date}. The new price applies at your first renewal on or after that date. Your plan renews automatically until you cancel.\n\nTo avoid the new price, cancel before your renewal. You keep your plan until the end of the period you paid for.\n\n${footer(url)}`,
  };
}

async function subscriptionsPage(db: Db, after: string | null) {
  const result = await db.execute(sql`
    select s.id, s.external_id as "externalId", s.workspace_id as "workspaceId", w.stripe_customer_id as "customerId",
      s.tier, s.cadence, s.period_end as "periodEnd", s.created_at as "createdAt", s.cancel_at_period_end as "cancelAtPeriodEnd"
    from subscriptions s join workspaces w on w.id = s.workspace_id
    where s.status = 'active' and s.cancel_at_period_end = false and s.period_end is not null
      and w.stripe_customer_id is not null and (${after}::uuid is null or s.id > ${after}::uuid)
    order by s.id limit ${billingNoticePolicy.batchSize}`);
  const rows = Array.isArray(result) ? result : (result as unknown as { rows: Record<string, unknown>[] }).rows;
  const subscriptions: NoticeSubscription[] = rows.flatMap((row) => isPaidTierKey(row.tier) && isBillingCadence(row.cadence) ? [{
    ...row, id: String(row.id), externalId: typeof row.externalId === "string" ? row.externalId : null, workspaceId: String(row.workspaceId), customerId: String(row.customerId),
    tier: row.tier, cadence: row.cadence, periodEnd: new Date(String(row.periodEnd)), createdAt: new Date(String(row.createdAt)), cancelAtPeriodEnd: Boolean(row.cancelAtPeriodEnd),
  }] : []);
  return { subscriptions, lastId: rows.length ? String(rows[rows.length - 1]!.id) : null, hasMore: rows.length === billingNoticePolicy.batchSize };
}

export async function runRenewalNotices(input: {
  db: Db; stripe: Stripe; now?: Date; dryRun?: boolean;
  priceChange?: { tier: PaidTierKey; cadence: BillingCadence; newUsd: number; effective: Date };
  send?: ReturnType<typeof billingTransactionalSender>;
  prices?: PriceTable;
}) {
  const now = input.now ?? new Date();
  if (input.priceChange) validatePriceNotice(input.priceChange, now);
  const send = input.send ?? billingTransactionalSender(input.db, optionalEnv);
  const prices = input.prices ?? buildPriceTable();
  const report = { considered: 0, due: 0, sent: 0, failed: 0, dryRun: input.dryRun ?? false };
  let after: string | null = null;
  for (;;) {
    const page = await subscriptionsPage(input.db, after);
    for (const subscription of page.subscriptions) {
      report.considered++;
      const price = input.priceChange;
      if (!price && !renewalNoticeDue(subscription, now)) continue;
      try {
        const verified = await verifiedRenewalTerms(input.stripe, subscription, prices, now);
        if (!verified) continue;
        // The price-change amount is the operator's explicit future-price
        // declaration. Match recipients to their verified renewal target,
        // not the plan they are leaving before the effective date.
        const notice = price
          ? verified.quote.tier === price.tier && verified.quote.cadence === price.cadence
            ? priceNotice({ ...verified.subscription, tier: verified.quote.tier, cadence: verified.quote.cadence }, price, siteUrl()) : null
          : renewalNotice(verified.subscription, now, siteUrl(), verified.quote);
        if (!notice) continue;
        report.due++;
        if (input.dryRun) continue;
        const customer = await input.stripe.customers.retrieve(subscription.customerId, {}, STRIPE_LOOKUP_OPTIONS);
        if (customer.id !== subscription.customerId || customer.deleted || !customer.email) { report.failed++; continue; }
        const result = await send({ from: optionalEnv("BILLING_EMAIL_FROM") ?? "", to: customer.email,
          subject: notice.subject, text: notice.text, idempotencyKey: notice.key, replyTo: LEGAL_FACTS.support.email });
        if (result.ok) report.sent++; else report.failed++;
      } catch { report.failed++; }
    }
    if (!page.hasMore) break;
    after = page.lastId;
  }
  return report;
}
