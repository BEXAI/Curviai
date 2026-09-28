/**
 * Stripe webhook verification and processing. The route handler verifies the
 * signature with the official SDK, then hands the typed event to
 * processStripeEvent with an injectable BillingStore, so the whole flow unit
 * tests without any network or database.
 *
 * Idempotency: every credit grant is keyed on the Stripe object that paid for
 * it (invoice:<id> for subscription invoices, checkout:<id> for top ups), not
 * on the event id, so a retried delivery or a second event about the same
 * payment can never grant twice. The database store claims that key and
 * writes the ledger row in one transaction (Update.md 1.3).
 *
 * Grant rules:
 * - Subscription credits are granted only on invoice.paid. A monthly invoice
 *   grants one month of the tier allowance; an annual invoice grants the full
 *   year (Phase 10 decision 2).
 * - A plan change can never create credits. Each proration line counts for
 *   the share of a full period that Stripe itself prorated: the line amount
 *   over the tier's full period price from the seed, for monthly and annual
 *   prices alike. An upgrade grants the new minus the old allowance for the
 *   time left and a downgrade takes the same amount back. A charge line never
 *   counts more than Stripe charged and a credit line never less than Stripe
 *   returned. The downgrade debit is taken in full, even below a zero
 *   balance: the debt blocks new packs until a top up or a renewal covers
 *   it. Upgrade, spend, downgrade therefore nets nothing beyond what was
 *   actually paid for on the bigger plan.
 * - Top ups are granted only once Checkout reports the payment as paid,
 *   including delayed methods through async_payment_succeeded (Update.md 1.4).
 * - A refund, or dispute funds being withdrawn, claws back the credits that
 *   payment granted, in proportion to the amount reversed, never taking the
 *   balance below zero (Phase 10 decision 3). A shortfall left by a low
 *   balance is collected by the next reversal event for the same payment, if
 *   one arrives. Inquiries take nothing. A won dispute gives back exactly what
 *   its clawback took, once, keyed on the dispute id.
 *
 * Subscription sync: Stripe does not deliver events in order. Every
 * customer.subscription.* event reads the subscription's current state from
 * Stripe instead of trusting the payload. The database store reads it before
 * it opens a transaction, then writes only if nothing else wrote the
 * subscription in between, and reads again otherwise. No status ever moves
 * out of canceled or incomplete_expired, or back to incomplete.
 */

import Stripe from "stripe";
import type { TierKey } from "@curvi/pipeline/seed";
import { allowanceCredits, type BillingCadence } from "./plans";
import type { PriceMapping, PriceTable } from "./price-table";
import { acceptsSubscriptionStatus } from "./subscription-status";

export interface GrantPaymentRef {
  invoiceId?: string | null;
  paymentIntentId?: string | null;
  checkoutSessionId?: string | null;
}

export interface CreditGrant {
  workspaceId: string | null;
  stripeCustomerId: string | null;
  credits: number;
  reason: "grant" | "topup";
  expiresMonths: number | null;
  /** What paid for the grant, so a later refund or dispute can find it. */
  payment?: GrantPaymentRef;
  /** Breakdown kept on the audit row. */
  detail?: Record<string, unknown>;
}

/** The part of a subscription the workspace cares about. */
export interface SubscriptionState {
  tier: TierKey | null;
  status: string;
  periodEnd: string | null;
  /**
   * Stripe will end the subscription on its own: cancel_at_period_end is set
   * (the cancel flow) or cancel_at is (the portal may use it). The in memory
   * store keeps it; the subscriptions table has no column for it yet, so the
   * database store does not persist it and account deletion reads Stripe
   * live instead.
   */
  cancelAtPeriodEnd?: boolean;
}

export interface SubscriptionUpdate extends SubscriptionState {
  workspaceId: string | null;
  stripeCustomerId: string | null;
  externalId: string;
  /**
   * Reads the subscription's current state from the provider. The store
   * calls it before it takes any lock or database connection, then checks
   * under the lock that nobody wrote the subscription since, and calls it
   * again if someone did. Every write therefore carries a state read after
   * the write before it, so the last write holds the newest state whatever
   * order the events arrived in. null means the provider no longer knows the
   * subscription; the event's own state is used.
   */
  refresh?: () => Promise<SubscriptionState | null>;
}

export type SubscriptionSyncOutcome =
  | { status: "applied"; subscriptionStatus: string }
  /** An older state arrived after a newer one and was ignored. */
  | { status: "stale"; kept: string; incoming: string }
  /** Acknowledged without a workspace (Shopify only). */
  | { status: "unrouted" };

export interface CreditClawback {
  reason: "refund" | "dispute";
  chargeId: string | null;
  paymentIntentId: string | null;
  /** Cumulative share of the original payment now reversed, 0 to 1. */
  share: number;
  /** Set for a dispute: once the dispute is won and its credits restored,
   * a late clawback for it is skipped. */
  disputeId?: string | null;
  /** Finds the invoice a payment intent paid, used when no grant matches the
   * payment intent directly (subscription invoices). */
  resolveInvoiceId?: () => Promise<string | null>;
}

export type ClawbackOutcome =
  | { status: "applied"; workspaceId: string; targeted: number; clawedBack: number }
  | { status: "duplicate" }
  /** The dispute was already won and restored; nothing is taken. */
  | { status: "skipped" }
  | { status: "no_grant" };

export type RestoreOutcome =
  | { status: "applied"; workspaceId: string; restored: number }
  | { status: "duplicate" }
  /** No clawback took anything for this dispute. */
  | { status: "nothing_to_restore" };

/** Credits handed back when a plan change returns money for unused time on
 * a bigger plan (a downgrade, or annual to monthly). */
export interface CreditDebit {
  workspaceId: string | null;
  stripeCustomerId: string | null;
  credits: number;
  invoiceId: string;
  detail?: Record<string, unknown>;
}

export type DebitOutcome =
  | { status: "applied"; debited: number; balanceAfter: number }
  | { status: "duplicate" };

export type BillingNoteKind = "payment_failed" | "payment_action_required" | "async_payment_failed";

export interface BillingNote {
  kind: BillingNoteKind;
  workspaceId: string | null;
  stripeCustomerId: string | null;
  props: Record<string, unknown>;
}

export interface BillingStore {
  /** Writes the grant unless key was already processed. Returns true when written. */
  recordGrantOnce(key: string, grant: CreditGrant): Promise<boolean>;
  upsertSubscription(update: SubscriptionUpdate): Promise<SubscriptionSyncOutcome>;
  /** Stores the Stripe customer id on the workspace, so the customer portal
   * and customer-id-only events resolve without a backfill. */
  linkCustomer(workspaceId: string, stripeCustomerId: string): Promise<void>;
  /** Reverses the credits a refunded or disputed payment granted, once per
   * key (the event id for refunds, dispute:<id> for disputes). */
  clawbackOnce(key: string, clawback: CreditClawback): Promise<ClawbackOutcome>;
  /** Gives back what a won dispute's clawback took, once per dispute. */
  restoreDisputeOnce(disputeId: string): Promise<RestoreOutcome>;
  /** Takes back plan change credits once per key, in full, even below a
   * zero balance. */
  debitOnce(key: string, debit: CreditDebit): Promise<DebitOutcome>;
  /** Records a billing signal such as a failed renewal, once per event. */
  noteOnce(eventId: string, note: BillingNote): Promise<void>;
}

/**
 * A grant or subscription event that names no workspace and whose customer
 * is not linked to one. The route answers 500 so Stripe retries; linking the
 * customer (or resending the event after fixing its metadata) lets a retry
 * land the credits exactly once.
 */
export class UnroutableBillingEventError extends Error {
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = "UnroutableBillingEventError";
  }
}

/** Credits are stored with one decimal place. */
export function roundCredits(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Rounds down to one decimal place, so a grant never exceeds what was paid. */
export function floorCredits(value: number): number {
  return Math.floor(value * 10 + 1e-9) / 10;
}

/** Rounds up to one decimal place, so a debit never falls short. */
export function ceilCredits(value: number): number {
  return Math.ceil(value * 10 - 1e-9) / 10;
}

/** The clawback key for a dispute, shared by its clawback and its restore. */
export function disputeKey(disputeId: string): string {
  return `dispute:${disputeId}`;
}

interface StoredGrant {
  key: string;
  grant: CreditGrant;
  workspaceId: string | null;
}

type StoredSubscription = Omit<SubscriptionUpdate, "refresh">;

export class InMemoryBillingStore implements BillingStore {
  readonly grants: Array<{ eventId: string; grant: CreditGrant }> = [];
  readonly subscriptions = new Map<string, StoredSubscription>();
  readonly customerLinks = new Map<string, string>();
  readonly clawbacks: Array<{ eventId: string; workspaceId: string; grantKey: string; targeted: number; clawedBack: number }> = [];
  readonly restores: Array<{ disputeId: string; workspaceId: string; grantKey: string; restored: number }> = [];
  /** Credits spent on packs, the in memory stand in for reserve and charge. */
  readonly spends: Array<{ workspaceId: string; credits: number }> = [];
  readonly notes: Array<{ eventId: string; note: BillingNote }> = [];
  private readonly processed = new Set<string>();

  /** requireRouting makes a grant with no resolvable workspace throw, like
   * the database store does for Stripe events. */
  constructor(private readonly options: { requireRouting?: boolean } = {}) {}

  private resolveWorkspace(workspaceId: string | null, customerId: string | null): string | null {
    if (workspaceId) {
      return workspaceId;
    }
    if (customerId) {
      for (const [ws, customer] of this.customerLinks) {
        if (customer === customerId) {
          return ws;
        }
      }
    }
    return null;
  }

  private stored(): StoredGrant[] {
    return this.grants.map((entry) => ({
      key: entry.eventId,
      grant: entry.grant,
      workspaceId: this.resolveWorkspace(entry.grant.workspaceId, entry.grant.stripeCustomerId),
    }));
  }

  /** Granted minus clawed back, debited and spent credits plus restores, the
   * in memory stand in for the ledger. */
  balance(workspaceId: string): number {
    const granted = this.stored()
      .filter((entry) => entry.workspaceId === workspaceId)
      .reduce((sum, entry) => sum + entry.grant.credits, 0);
    const clawed = this.clawbacks
      .filter((entry) => entry.workspaceId === workspaceId)
      .reduce((sum, entry) => sum + entry.clawedBack, 0);
    const restored = this.restores
      .filter((entry) => entry.workspaceId === workspaceId)
      .reduce((sum, entry) => sum + entry.restored, 0);
    const spent = this.spends
      .filter((entry) => entry.workspaceId === workspaceId)
      .reduce((sum, entry) => sum + entry.credits, 0);
    return roundCredits(granted - clawed + restored - spent);
  }

  /** Spends credits the way a pack does: refused when the balance is short. */
  spend(workspaceId: string, credits: number): boolean {
    if (credits <= 0 || this.balance(workspaceId) < credits) {
      return false;
    }
    this.spends.push({ workspaceId, credits });
    return true;
  }

  async recordGrantOnce(key: string, grant: CreditGrant): Promise<boolean> {
    if (
      this.options.requireRouting &&
      !this.resolveWorkspace(grant.workspaceId, grant.stripeCustomerId)
    ) {
      throw new UnroutableBillingEventError(`No workspace for billing grant ${key}`);
    }
    if (this.processed.has(key)) {
      return false;
    }
    this.processed.add(key);
    this.grants.push({ eventId: key, grant });
    return true;
  }

  async upsertSubscription(update: SubscriptionUpdate): Promise<SubscriptionSyncOutcome> {
    const { refresh, ...payload } = update;
    const incoming: SubscriptionState = (refresh ? await refresh() : null) ?? payload;
    const current = this.subscriptions.get(update.externalId);
    if (current && !acceptsSubscriptionStatus(current.status, incoming.status)) {
      return { status: "stale", kept: current.status, incoming: incoming.status };
    }
    this.subscriptions.set(update.externalId, {
      ...payload,
      tier: incoming.tier ?? current?.tier ?? null,
      status: incoming.status,
      periodEnd: incoming.periodEnd ?? current?.periodEnd ?? null,
      cancelAtPeriodEnd: incoming.cancelAtPeriodEnd ?? current?.cancelAtPeriodEnd ?? false,
    });
    return { status: "applied", subscriptionStatus: incoming.status };
  }

  async linkCustomer(workspaceId: string, stripeCustomerId: string): Promise<void> {
    this.customerLinks.set(workspaceId, stripeCustomerId);
  }

  /** Taken back from a grant and not given back yet. */
  private netClawedBack(grantKey: string): number {
    const clawed = this.clawbacks
      .filter((entry) => entry.grantKey === grantKey)
      .reduce((sum, entry) => sum + entry.clawedBack, 0);
    const restored = this.restores
      .filter((entry) => entry.grantKey === grantKey)
      .reduce((sum, entry) => sum + entry.restored, 0);
    return roundCredits(clawed - restored);
  }

  async clawbackOnce(key: string, clawback: CreditClawback): Promise<ClawbackOutcome> {
    const claim = `clawback:${key}`;
    if (this.processed.has(claim)) {
      return { status: "duplicate" };
    }
    if (clawback.disputeId && this.processed.has(`restore:${disputeKey(clawback.disputeId)}`)) {
      this.processed.add(claim);
      return { status: "skipped" };
    }
    let target = clawback.paymentIntentId
      ? this.stored().find((entry) => entry.grant.payment?.paymentIntentId === clawback.paymentIntentId)
      : undefined;
    if (!target && clawback.resolveInvoiceId) {
      const invoiceId = await clawback.resolveInvoiceId();
      target = invoiceId
        ? this.stored().find((entry) => entry.grant.payment?.invoiceId === invoiceId)
        : undefined;
    }
    if (!target?.workspaceId) {
      return { status: "no_grant" };
    }
    this.processed.add(claim);
    // Like the database store, what earlier reversals actually took back
    // counts as prior, so a later event can collect an earlier shortfall.
    const prior = this.netClawedBack(target.key);
    const targeted = Math.max(0, roundCredits(target.grant.credits * clampShare(clawback.share) - prior));
    const clawedBack = Math.min(targeted, Math.max(0, this.balance(target.workspaceId)));
    this.clawbacks.push({ eventId: key, workspaceId: target.workspaceId, grantKey: target.key, targeted, clawedBack });
    return { status: "applied", workspaceId: target.workspaceId, targeted, clawedBack };
  }

  async restoreDisputeOnce(disputeId: string): Promise<RestoreOutcome> {
    const claim = `restore:${disputeKey(disputeId)}`;
    if (this.processed.has(claim)) {
      return { status: "duplicate" };
    }
    this.processed.add(claim);
    const clawed = this.clawbacks.find((entry) => entry.eventId === disputeKey(disputeId));
    if (!clawed || clawed.clawedBack <= 0) {
      return { status: "nothing_to_restore" };
    }
    const restored = roundCredits(Math.min(clawed.clawedBack, Math.max(0, this.netClawedBack(clawed.grantKey))));
    if (restored <= 0) {
      return { status: "nothing_to_restore" };
    }
    this.restores.push({ disputeId, workspaceId: clawed.workspaceId, grantKey: clawed.grantKey, restored });
    return { status: "applied", workspaceId: clawed.workspaceId, restored };
  }

  async debitOnce(key: string, debit: CreditDebit): Promise<DebitOutcome> {
    const workspaceId = this.resolveWorkspace(debit.workspaceId, debit.stripeCustomerId);
    if (!workspaceId) {
      if (this.options.requireRouting) {
        throw new UnroutableBillingEventError(`No workspace for billing debit ${key}`);
      }
      return { status: "duplicate" };
    }
    if (this.processed.has(key)) {
      return { status: "duplicate" };
    }
    this.processed.add(key);
    // The full difference, even below zero: Stripe returned the money in full.
    this.clawbacks.push({ eventId: key, workspaceId, grantKey: `debit:${key}`, targeted: debit.credits, clawedBack: debit.credits });
    return { status: "applied", debited: debit.credits, balanceAfter: this.balance(workspaceId) };
  }

  async noteOnce(eventId: string, note: BillingNote): Promise<void> {
    const key = `note:${eventId}`;
    if (this.processed.has(key)) {
      return;
    }
    this.processed.add(key);
    this.notes.push({ eventId, note });
  }
}

const globalScope = globalThis as typeof globalThis & { __curviBillingStore?: InMemoryBillingStore };

/** Demo mode store so webhook handling stays observable without a database. */
export function getInMemoryBillingStore(): InMemoryBillingStore {
  globalScope.__curviBillingStore ??= new InMemoryBillingStore();
  return globalScope.__curviBillingStore;
}

/**
 * Verifies the Stripe-Signature header against the raw request body.
 * constructEvent never touches the network, so the placeholder api key is
 * irrelevant; only the webhook secret matters.
 */
export function verifyStripeEvent(rawBody: string, signature: string, webhookSecret: string): Stripe.Event {
  const stripe = new Stripe("sk_verification_only");
  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}

/** Every event type processStripeEvent acts on. Subscribe the webhook
 * endpoint to exactly these (docs/STRIPE_SETUP.md). */
export const HANDLED_STRIPE_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
  "charge.dispute.closed",
] as const;

/** Read only Stripe lookups, injected so tests run without the network. */
export interface StripeLookup {
  invoiceIdForPaymentIntent(paymentIntentId: string): Promise<string | null>;
  /** The subscription as Stripe holds it now, or null when Stripe no longer
   * knows it. Throws on a network or API failure so Stripe retries. */
  retrieveSubscription?(subscriptionId: string): Promise<Stripe.Subscription | null>;
}

export interface StripeProcessDeps {
  lookup?: StripeLookup;
}

export interface StripeProcessResult {
  handled: boolean;
  action: string;
  duplicate?: boolean;
  credits?: number;
}

function clampShare(share: number): number {
  if (!Number.isFinite(share)) {
    return 1;
  }
  return Math.min(1, Math.max(0, share));
}

function metadataValue(metadata: Stripe.Metadata | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function idOf(value: string | { id?: string } | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return typeof value.id === "string" ? value.id : null;
}

interface InvoiceLineView {
  priceId: string | null;
  amount: number;
  proration: boolean;
  periodStart: number | null;
  periodEnd: number | null;
}

/** Normalizes invoice lines across the basil shape and the legacy shape. */
function invoiceLines(invoice: Stripe.Invoice): InvoiceLineView[] {
  return (invoice.lines?.data ?? []).map((line) => {
    const legacy = line as unknown as { price?: { id?: string }; proration?: boolean };
    const priceDetails = line.pricing?.price_details?.price as unknown;
    const priceId =
      (typeof priceDetails === "string" && priceDetails.length > 0 ? priceDetails : null) ??
      idOf(priceDetails as { id?: string } | null) ??
      idOf(legacy.price ?? null);
    const proration =
      line.parent?.subscription_item_details?.proration ??
      line.parent?.invoice_item_details?.proration ??
      legacy.proration ??
      false;
    return {
      priceId,
      amount: typeof line.amount === "number" ? line.amount : 0,
      proration,
      periodStart: line.period?.start ?? null,
      periodEnd: line.period?.end ?? null,
    };
  });
}

/**
 * Start of a billing period that ends at `endSeconds`, one month (or year)
 * earlier at the same time of day. Stripe keeps a subscription's anchor day
 * and clamps it to the end of a shorter month, so a period ending on
 * February 28 may have started on any of January 28 to 31.
 * - "longest" (the default) is the calendar start: the same day, clamped to
 *   the end of a shorter month. Stripe's real period is never longer.
 * - "shortest" also moves a month end start to the last day of that month
 *   (April 30 back to March 31, February 28 back to January 31), the latest
 *   start an anchor could give. Stripe's real period is never shorter.
 */
export function billingPeriodStart(
  endSeconds: number,
  cadence: BillingCadence,
  bound: "longest" | "shortest" = "longest",
): number {
  const end = new Date(endSeconds * 1000);
  const year = end.getUTCFullYear();
  const month = end.getUTCMonth() - (cadence === "annual" ? 12 : 1);
  // Date.UTC normalizes negative months into the previous year; day 0 of the
  // next month is the last day of this one.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const endIsMonthEnd = end.getUTCDate() === new Date(Date.UTC(year, end.getUTCMonth() + 1, 0)).getUTCDate();
  const day = bound === "shortest" && endIsMonthEnd ? lastDay : Math.min(end.getUTCDate(), lastDay);
  return (
    Date.UTC(year, month, day, end.getUTCHours(), end.getUTCMinutes(), end.getUTCSeconds(), end.getUTCMilliseconds()) /
    1000
  );
}

/**
 * The time a proration line covers as a share of the longest and of the
 * shortest billing period that can end with it, each 0 to 1. The share
 * Stripe prorated lies between the two: `floor` is the calendar share, too
 * small for a period whose end was clamped (January 31 to February 28), and
 * `ceiling` is never smaller than Stripe's. Without a period the line
 * counts in full.
 */
export function timeShareBounds(
  line: { periodStart: number | null; periodEnd: number | null },
  cadence: BillingCadence,
): { floor: number; ceiling: number } {
  const { periodStart, periodEnd } = line;
  if (periodStart === null || periodEnd === null || periodEnd <= periodStart) {
    return { floor: 1, ceiling: 1 };
  }
  const shareOf = (start: number): number =>
    periodEnd > start ? clampShare((periodEnd - periodStart) / (periodEnd - start)) : 1;
  return {
    floor: shareOf(billingPeriodStart(periodEnd, cadence, "longest")),
    ceiling: shareOf(billingPeriodStart(periodEnd, cadence, "shortest")),
  };
}

/** The currency the seed prices are in, as Stripe writes it. */
const SEED_CURRENCY = "usd";

/**
 * How far Stripe's amount share may sit outside the time bounds and still
 * count as an undiscounted, seed priced proration (cent rounding).
 */
const AMOUNT_SHARE_TOLERANCE = 0.005;

/**
 * Share of a full billing period a proration line stands for, 0 to 1.
 *
 * Stripe prorates against the subscription's real current period, so when
 * the price matches the seed and no discount applies, the line amount over
 * the tier's full period price (from the seed, in cents) is exactly the
 * share of time it covers, also for short and clamped periods where a
 * calendar month would be wrong. That share always falls inside the time
 * bounds of the line (timeShareBounds), and both sides of a change use it.
 *
 * Stripe computes prorations from the subscription's discounted price
 * (docs.stripe.com/billing/subscriptions/prorations, "Prorations and
 * discounts", checked 2026-09-28), so a coupon shrinks the amount share
 * below the time left on both sides. Renewals grant a full allowance
 * whatever the discount, so plan change credits must follow time, not
 * money, or a discounted customer could downgrade right after a renewal and
 * keep credits. When the amount share is outside the time bounds (a
 * discount, a Stripe price that differs from the seed, another currency,
 * no price), the line counts the side of the time bounds that cannot create
 * credits: a charge line the shortest share of time it can cover, a credit
 * line the longest. Each tier has at least twice the credits of the one
 * below, so an upgrade still always adds credits, and no upgrade, downgrade
 * or round trip can add credits beyond what the time paid for.
 */
export function prorationShare(
  line: { amount: number; periodStart: number | null; periodEnd: number | null },
  price: { cadence: BillingCadence; priceCents: number },
  currency: string | null = SEED_CURRENCY,
): number {
  const { floor, ceiling } = timeShareBounds(line, price.cadence);
  const comparable =
    price.priceCents > 0 &&
    Number.isFinite(line.amount) &&
    (currency ?? SEED_CURRENCY).toLowerCase() === SEED_CURRENCY;
  if (comparable) {
    const stripeShare = Math.abs(line.amount) / price.priceCents;
    if (stripeShare >= floor - AMOUNT_SHARE_TOLERANCE && stripeShare <= ceiling + AMOUNT_SHARE_TOLERANCE) {
      return clampShare(Math.min(Math.max(stripeShare, floor), ceiling));
    }
  }
  return line.amount < 0 ? ceiling : floor;
}

type TierMapping = Extract<PriceMapping, { kind: "tier" }>;

function tierMapping(table: PriceTable, priceId: string | null): TierMapping | null {
  const mapping = priceId ? table[priceId] : undefined;
  return mapping?.kind === "tier" ? mapping : null;
}

export interface InvoiceGrantPlan {
  /** Credits to add. */
  credits: number;
  /** Credits to take back, when a plan change returned money for unused
   * time on a bigger plan. Never both credits and debit. */
  debit: number;
  tier: TierKey | null;
  cadence: BillingCadence | null;
  billingReason: string | null;
  /** A full period allowance from a create or cycle invoice. */
  base: number;
  /** Allowance for the new side of a plan change, for the time it covers. */
  changeNew: number;
  /** Allowance already granted for the old side of a plan change, for the
   * time it covers. */
  changeOld: number;
}

const PERIOD_REASONS = new Set(["subscription_create", "subscription_cycle"]);

/** Two decimals, for the audit breakdown only. */
function auditCredits(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Works out what a paid subscription invoice grants.
 * - subscription_create and subscription_cycle: one full period of the
 *   subscription line's tier (12 months up front for an annual price).
 * - A non proration line on a subscription_update invoice (an interval
 *   change starts a new full period): that full period's allowance.
 * - Proration lines: the line's tier allowance times the share Stripe
 *   prorated (prorationShare). Positive lines add, credit lines subtract.
 *   The net is rounded down when it grants and up when it takes back, so
 *   rounding never creates credits.
 * - Any other billing reason grants nothing.
 */
export function planInvoiceGrant(invoice: Stripe.Invoice, table: PriceTable): InvoiceGrantPlan {
  const billingReason = invoice.billing_reason ?? null;
  const currency = typeof invoice.currency === "string" && invoice.currency.length > 0 ? invoice.currency : null;
  const lines = invoiceLines(invoice);
  let base = 0;
  let changeNew = 0;
  let changeOld = 0;
  let tier: TierKey | null = null;
  let cadence: BillingCadence | null = null;

  for (const line of lines) {
    const mapping = tierMapping(table, line.priceId);
    if (!mapping) {
      continue;
    }
    if (!line.proration) {
      if (line.amount < 0) {
        continue;
      }
      if (billingReason && PERIOD_REASONS.has(billingReason)) {
        if (base === 0) {
          base = allowanceCredits(mapping.creditsPerMonth, mapping.cadence);
          tier = mapping.tier;
          cadence = mapping.cadence;
        }
      } else if (billingReason === "subscription_update") {
        changeNew += allowanceCredits(mapping.creditsPerMonth, mapping.cadence);
        tier = mapping.tier;
        cadence = mapping.cadence;
      }
      continue;
    }
    const credits =
      allowanceCredits(mapping.creditsPerMonth, mapping.cadence) * prorationShare(line, mapping, currency);
    if (line.amount > 0) {
      changeNew += credits;
      tier ??= mapping.tier;
      cadence ??= mapping.cadence;
    } else if (line.amount < 0) {
      changeOld += credits;
    }
  }

  const net = base + changeNew - changeOld;
  return {
    credits: net > 0 ? floorCredits(net) : 0,
    debit: net < 0 ? ceilCredits(-net) : 0,
    tier,
    cadence,
    billingReason,
    base,
    changeNew: auditCredits(changeNew),
    changeOld: auditCredits(changeOld),
  };
}

function invoiceWorkspaceId(invoice: Stripe.Invoice): string | null {
  const subscriptionDetails =
    invoice.parent?.type === "subscription_details" ? invoice.parent.subscription_details : null;
  return (
    metadataValue(subscriptionDetails?.metadata ?? null, "workspaceId") ??
    metadataValue(invoice.metadata ?? null, "workspaceId")
  );
}

/** Top ups count as paid once Checkout says so; a 100 percent promotion code
 * reports no_payment_required and grants too. */
function checkoutIsPaid(session: Stripe.Checkout.Session): boolean {
  return session.payment_status === "paid" || session.payment_status === "no_payment_required";
}

async function grantTopUp(
  session: Stripe.Checkout.Session,
  table: PriceTable,
  store: BillingStore,
): Promise<StripeProcessResult | null> {
  const priceId = metadataValue(session.metadata, "priceId");
  const mapping = priceId ? table[priceId] : undefined;
  if (session.mode !== "payment" || mapping?.kind !== "topup") {
    return null;
  }
  if (!checkoutIsPaid(session)) {
    return { handled: true, action: "topup_awaiting_payment" };
  }
  const written = await store.recordGrantOnce(`checkout:${session.id}`, {
    workspaceId: metadataValue(session.metadata, "workspaceId") ?? session.client_reference_id,
    stripeCustomerId: idOf(session.customer),
    credits: mapping.credits,
    reason: "topup",
    expiresMonths: mapping.expiresMonths,
    payment: {
      checkoutSessionId: session.id,
      paymentIntentId: idOf(session.payment_intent),
      invoiceId: idOf(session.invoice),
    },
    detail: { priceId },
  });
  return { handled: true, action: "topup_granted", duplicate: !written, credits: mapping.credits };
}

async function clawback(
  key: string,
  input: Omit<CreditClawback, "resolveInvoiceId">,
  store: BillingStore,
  deps: StripeProcessDeps,
): Promise<StripeProcessResult> {
  const paymentIntentId = input.paymentIntentId;
  const lookup = deps.lookup;
  const outcome = await store.clawbackOnce(key, {
    ...input,
    resolveInvoiceId:
      paymentIntentId && lookup ? () => lookup.invoiceIdForPaymentIntent(paymentIntentId) : undefined,
  });
  const action = input.reason === "refund" ? "refund" : "dispute";
  switch (outcome.status) {
    case "applied":
      return { handled: true, action: `${action}_clawed_back`, credits: outcome.clawedBack };
    case "duplicate":
      return { handled: true, action: `${action}_clawed_back`, duplicate: true };
    case "skipped":
      return { handled: true, action: "dispute_already_won" };
    default:
      return { handled: true, action: `${action}_no_grant` };
  }
}

/** The subscription state a Stripe subscription object stands for. */
function subscriptionState(
  subscription: Stripe.Subscription,
  table: PriceTable,
  deleted: boolean,
): SubscriptionState {
  const item = subscription.items?.data?.[0];
  const mapping = tierMapping(table, item?.price?.id ?? null);
  return {
    tier: mapping ? mapping.tier : null,
    status: deleted ? "canceled" : subscription.status,
    periodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000).toISOString() : null,
    cancelAtPeriodEnd:
      !deleted && (subscription.cancel_at_period_end === true || typeof subscription.cancel_at === "number"),
  };
}

/** Inquiries (warning_*) never move money, so they never move credits. */
function isInquiry(status: string): boolean {
  return status.startsWith("warning_");
}

export async function processStripeEvent(
  event: Stripe.Event,
  table: PriceTable,
  store: BillingStore,
  deps: StripeProcessDeps = {},
): Promise<StripeProcessResult> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      // Write the customer id back to the workspace on every completed
      // checkout, so the portal works without a backfill (audit follow up).
      const checkoutWorkspaceId =
        metadataValue(session.metadata, "workspaceId") ?? session.client_reference_id;
      const checkoutCustomerId = idOf(session.customer);
      if (checkoutWorkspaceId && checkoutCustomerId) {
        await store.linkCustomer(checkoutWorkspaceId, checkoutCustomerId);
      }
      return (await grantTopUp(session, table, store)) ?? { handled: true, action: "checkout_noted" };
    }

    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object;
      return (await grantTopUp(session, table, store)) ?? { handled: true, action: "checkout_noted" };
    }

    case "checkout.session.async_payment_failed": {
      const session = event.data.object;
      await store.noteOnce(event.id, {
        kind: "async_payment_failed",
        workspaceId: metadataValue(session.metadata, "workspaceId") ?? session.client_reference_id,
        stripeCustomerId: idOf(session.customer),
        props: { checkoutSessionId: session.id, priceId: metadataValue(session.metadata, "priceId") },
      });
      return { handled: true, action: "topup_payment_failed" };
    }

    case "invoice.paid": {
      const invoice = event.data.object;
      const plan = planInvoiceGrant(invoice, table);
      const detail = {
        billingReason: plan.billingReason,
        tier: plan.tier,
        cadence: plan.cadence,
        base: plan.base,
        changeNew: plan.changeNew,
        changeOld: plan.changeOld,
      };
      if (!invoice.id || (plan.credits <= 0 && plan.debit <= 0)) {
        return { handled: true, action: "invoice_noted" };
      }
      if (plan.debit > 0) {
        const outcome = await store.debitOnce(`invoice:${invoice.id}`, {
          workspaceId: invoiceWorkspaceId(invoice),
          stripeCustomerId: idOf(invoice.customer),
          credits: plan.debit,
          invoiceId: invoice.id,
          detail,
        });
        return outcome.status === "applied"
          ? { handled: true, action: "plan_change_credits_returned", credits: outcome.debited }
          : { handled: true, action: "plan_change_credits_returned", duplicate: true };
      }
      const written = await store.recordGrantOnce(`invoice:${invoice.id}`, {
        workspaceId: invoiceWorkspaceId(invoice),
        stripeCustomerId: idOf(invoice.customer),
        credits: plan.credits,
        reason: "grant",
        expiresMonths: null,
        payment: { invoiceId: invoice.id },
        detail,
      });
      const action = plan.base > 0 ? "cycle_credits_granted" : "plan_change_credits_granted";
      return { handled: true, action, duplicate: !written, credits: plan.credits };
    }

    case "invoice.payment_failed":
    case "invoice.payment_action_required": {
      const invoice = event.data.object;
      await store.noteOnce(event.id, {
        kind: event.type === "invoice.payment_failed" ? "payment_failed" : "payment_action_required",
        workspaceId: invoiceWorkspaceId(invoice),
        stripeCustomerId: idOf(invoice.customer),
        props: {
          invoiceId: invoice.id ?? null,
          attemptCount: invoice.attempt_count ?? null,
          nextPaymentAttempt: invoice.next_payment_attempt ?? null,
          amountDue: invoice.amount_due ?? null,
        },
      });
      return {
        handled: true,
        action: event.type === "invoice.payment_failed" ? "payment_failure_noted" : "payment_action_noted",
      };
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      const deleted = event.type === "customer.subscription.deleted";
      const retrieve = deps.lookup?.retrieveSubscription?.bind(deps.lookup);
      const outcome = await store.upsertSubscription({
        workspaceId: metadataValue(subscription.metadata, "workspaceId"),
        stripeCustomerId: idOf(subscription.customer),
        externalId: subscription.id,
        ...subscriptionState(subscription, table, deleted),
        // The payload may be older than a state already stored, so the
        // store reads Stripe's current state (before taking its lock) and
        // writes it only if nothing wrote the subscription meanwhile.
        refresh: retrieve
          ? async () => {
              const current = await retrieve(subscription.id);
              return current ? subscriptionState(current, table, deleted) : null;
            }
          : undefined,
      });
      return {
        handled: true,
        action: outcome.status === "stale" ? "subscription_stale_ignored" : "subscription_synced",
      };
    }

    case "charge.refunded": {
      const charge = event.data.object;
      const share = charge.amount > 0 ? charge.amount_refunded / charge.amount : 1;
      return clawback(
        event.id,
        { reason: "refund", chargeId: charge.id, paymentIntentId: idOf(charge.payment_intent), share },
        store,
        deps,
      );
    }

    case "charge.dispute.funds_withdrawn": {
      const dispute = event.data.object;
      const status = typeof dispute.status === "string" ? dispute.status : "";
      if (isInquiry(status) || !dispute.id) {
        return { handled: true, action: "dispute_inquiry_ignored" };
      }
      // Keyed on the dispute, so a second withdrawal for the same dispute
      // (a fee, a corrected amount) never takes credits twice.
      return clawback(
        disputeKey(dispute.id),
        {
          reason: "dispute",
          chargeId: idOf(dispute.charge),
          paymentIntentId: idOf(dispute.payment_intent),
          share: 1,
          disputeId: dispute.id,
        },
        store,
        deps,
      );
    }

    case "charge.dispute.funds_reinstated":
    case "charge.dispute.closed": {
      const dispute = event.data.object;
      // funds_reinstated also fires when a dispute on a partly refunded
      // payment is lost (Stripe gives back the refunded part), so only a
      // won dispute gives credits back.
      if (dispute.status !== "won" || !dispute.id) {
        return { handled: true, action: "dispute_closed_noted" };
      }
      const outcome = await store.restoreDisputeOnce(dispute.id);
      switch (outcome.status) {
        case "applied":
          return { handled: true, action: "dispute_won_credits_restored", credits: outcome.restored };
        case "duplicate":
          return { handled: true, action: "dispute_won_credits_restored", duplicate: true };
        default:
          return { handled: true, action: "dispute_won_nothing_to_restore" };
      }
    }

    default:
      return { handled: false, action: "ignored" };
  }
}
