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
 * - A plan change grants only the difference between the new and the old
 *   allowance for the time the proration covers, never a second full period.
 * - Top ups are granted only once Checkout reports the payment as paid,
 *   including delayed methods through async_payment_succeeded (Update.md 1.4).
 * - A refund or dispute claws back the credits that payment granted, in
 *   proportion to the amount reversed, never taking the balance below zero
 *   (Phase 10 decision 3). A shortfall left by a low balance is collected by
 *   the next reversal event for the same payment, if one arrives.
 */

import Stripe from "stripe";
import type { TierKey } from "@curvi/pipeline/seed";
import { allowanceCredits, type BillingCadence } from "./plans";
import type { PriceMapping, PriceTable } from "./price-table";

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

export interface SubscriptionUpdate {
  workspaceId: string | null;
  stripeCustomerId: string | null;
  externalId: string;
  tier: TierKey | null;
  status: string;
  periodEnd: string | null;
}

export interface CreditClawback {
  reason: "refund" | "dispute";
  chargeId: string | null;
  paymentIntentId: string | null;
  /** Cumulative share of the original payment now reversed, 0 to 1. */
  share: number;
  /** Finds the invoice a payment intent paid, used when no grant matches the
   * payment intent directly (subscription invoices). */
  resolveInvoiceId?: () => Promise<string | null>;
}

export type ClawbackOutcome =
  | { status: "applied"; workspaceId: string; targeted: number; clawedBack: number }
  | { status: "duplicate" }
  | { status: "no_grant" };

/** Credits handed back when a plan change returns money for unused time on
 * a bigger plan (a downgrade, or annual to monthly). */
export interface CreditDebit {
  workspaceId: string | null;
  stripeCustomerId: string | null;
  credits: number;
  invoiceId: string;
  detail?: Record<string, unknown>;
}

export type DebitOutcome = { status: "applied"; debited: number } | { status: "duplicate" };

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
  upsertSubscription(update: SubscriptionUpdate): Promise<void>;
  /** Stores the Stripe customer id on the workspace, so the customer portal
   * and customer-id-only events resolve without a backfill. */
  linkCustomer(workspaceId: string, stripeCustomerId: string): Promise<void>;
  /** Reverses the credits a refunded or disputed payment granted, once per event. */
  clawbackOnce(eventId: string, clawback: CreditClawback): Promise<ClawbackOutcome>;
  /** Takes back plan change credits once per key, never below a zero balance. */
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

interface StoredGrant {
  key: string;
  grant: CreditGrant;
  workspaceId: string | null;
}

export class InMemoryBillingStore implements BillingStore {
  readonly grants: Array<{ eventId: string; grant: CreditGrant }> = [];
  readonly subscriptions = new Map<string, SubscriptionUpdate>();
  readonly customerLinks = new Map<string, string>();
  readonly clawbacks: Array<{ eventId: string; workspaceId: string; grantKey: string; targeted: number; clawedBack: number }> = [];
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

  /** Granted minus clawed back credits, the in memory stand in for the ledger. */
  balance(workspaceId: string): number {
    const granted = this.stored()
      .filter((entry) => entry.workspaceId === workspaceId)
      .reduce((sum, entry) => sum + entry.grant.credits, 0);
    const clawed = this.clawbacks
      .filter((entry) => entry.workspaceId === workspaceId)
      .reduce((sum, entry) => sum + entry.clawedBack, 0);
    return roundCredits(granted - clawed);
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

  async upsertSubscription(update: SubscriptionUpdate): Promise<void> {
    this.subscriptions.set(update.externalId, update);
  }

  async linkCustomer(workspaceId: string, stripeCustomerId: string): Promise<void> {
    this.customerLinks.set(workspaceId, stripeCustomerId);
  }

  async clawbackOnce(eventId: string, clawback: CreditClawback): Promise<ClawbackOutcome> {
    const key = `clawback:${eventId}`;
    if (this.processed.has(key)) {
      return { status: "duplicate" };
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
    this.processed.add(key);
    // Like the database store, what earlier reversals actually took back
    // counts as prior, so a later event can collect an earlier shortfall.
    const prior = this.clawbacks
      .filter((entry) => entry.grantKey === target.key)
      .reduce((sum, entry) => sum + entry.clawedBack, 0);
    const targeted = Math.max(0, roundCredits(target.grant.credits * clampShare(clawback.share) - prior));
    const clawedBack = Math.min(targeted, Math.max(0, this.balance(target.workspaceId)));
    this.clawbacks.push({ eventId, workspaceId: target.workspaceId, grantKey: target.key, targeted, clawedBack });
    return { status: "applied", workspaceId: target.workspaceId, targeted, clawedBack };
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
    const debited = Math.min(debit.credits, Math.max(0, this.balance(workspaceId)));
    this.clawbacks.push({ eventId: key, workspaceId, grantKey: `debit:${key}`, targeted: debit.credits, clawedBack: debited });
    return { status: "applied", debited };
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
  "charge.dispute.created",
] as const;

/** Read only Stripe lookups, injected so tests run without the network. */
export interface StripeLookup {
  invoiceIdForPaymentIntent(paymentIntentId: string): Promise<string | null>;
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

const DAY_SECONDS = 24 * 60 * 60;
const MONTH_DAYS = 365 / 12;

/** Whole months of allowance a line's service period stands for. A monthly
 * price covers one month; an annual price covers the months left in its
 * period, so a mid year change prorates the yearly allowance. */
function monthsCovered(line: InvoiceLineView, cadence: BillingCadence): number {
  if (cadence === "monthly") {
    return 1;
  }
  if (line.periodStart === null || line.periodEnd === null || line.periodEnd <= line.periodStart) {
    return 12;
  }
  const months = Math.round((line.periodEnd - line.periodStart) / DAY_SECONDS / MONTH_DAYS);
  return Math.min(12, Math.max(1, months));
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
  /** Allowance for the new side of a plan change. */
  changeNew: number;
  /** Allowance already granted for the old side of a plan change. */
  changeOld: number;
}

const PERIOD_REASONS = new Set(["subscription_create", "subscription_cycle"]);

/**
 * Works out what a paid subscription invoice grants.
 * - subscription_create and subscription_cycle: one full period of the
 *   subscription line's tier (12 months up front for an annual price).
 * - Plan change lines (prorations, and the new price line of an interval
 *   change on a subscription_update invoice): the new allowance for the time
 *   covered minus the old allowance for the same time. An upgrade grants the
 *   difference once. A downgrade, where Stripe credits the unused money back,
 *   takes the matching credits back (never below a zero balance), so credits
 *   always follow the money.
 * - Any other billing reason grants nothing.
 */
export function planInvoiceGrant(invoice: Stripe.Invoice, table: PriceTable): InvoiceGrantPlan {
  const billingReason = invoice.billing_reason ?? null;
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
    const credits = mapping.creditsPerMonth * monthsCovered(line, mapping.cadence);
    if (line.amount > 0) {
      changeNew += credits;
      tier ??= mapping.tier;
      cadence ??= mapping.cadence;
    } else if (line.amount < 0) {
      changeOld += credits;
    }
  }

  const net = roundCredits(base + changeNew - changeOld);
  return {
    credits: Math.max(0, net),
    debit: Math.max(0, -net),
    tier,
    cadence,
    billingReason,
    base,
    changeNew,
    changeOld,
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
  eventId: string,
  input: Omit<CreditClawback, "resolveInvoiceId">,
  store: BillingStore,
  deps: StripeProcessDeps,
): Promise<StripeProcessResult> {
  const paymentIntentId = input.paymentIntentId;
  const lookup = deps.lookup;
  const outcome = await store.clawbackOnce(eventId, {
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
    default:
      return { handled: true, action: `${action}_no_grant` };
  }
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
      const item = subscription.items?.data?.[0];
      const priceId = item?.price?.id ?? null;
      const mapping = tierMapping(table, priceId);
      const periodEnd = item?.current_period_end
        ? new Date(item.current_period_end * 1000).toISOString()
        : null;
      await store.upsertSubscription({
        workspaceId: metadataValue(subscription.metadata, "workspaceId"),
        stripeCustomerId: idOf(subscription.customer),
        externalId: subscription.id,
        tier: mapping ? mapping.tier : null,
        status: event.type === "customer.subscription.deleted" ? "canceled" : subscription.status,
        periodEnd,
      });
      return { handled: true, action: "subscription_synced" };
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

    case "charge.dispute.created": {
      const dispute = event.data.object;
      return clawback(
        event.id,
        {
          reason: "dispute",
          chargeId: idOf(dispute.charge),
          paymentIntentId: idOf(dispute.payment_intent),
          share: 1,
        },
        store,
        deps,
      );
    }

    default:
      return { handled: false, action: "ignored" };
  }
}
