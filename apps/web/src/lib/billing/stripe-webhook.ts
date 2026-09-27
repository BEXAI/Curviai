/**
 * Stripe webhook verification and processing. The route handler verifies the
 * signature with the official SDK, then hands the typed event to
 * processStripeEvent with an injectable BillingStore, so the whole flow unit
 * tests without any network or database.
 *
 * Idempotency strategy: every credit grant is keyed on the Stripe event id.
 * BillingStore.recordGrantOnce writes the grant only when that event id has
 * not been seen, so Stripe retries and duplicate deliveries never double
 * grant. The in memory store dedupes with a Set; the database store checks
 * the events table for the event id before inserting the ledger row.
 */

import Stripe from "stripe";
import type { TierKey } from "@curvi/pipeline/seed";
import type { PriceTable } from "./price-table";

export interface CreditGrant {
  workspaceId: string | null;
  stripeCustomerId: string | null;
  credits: number;
  reason: "grant" | "topup";
  expiresMonths: number | null;
}

export interface SubscriptionUpdate {
  workspaceId: string | null;
  stripeCustomerId: string | null;
  externalId: string;
  tier: TierKey | null;
  status: string;
  periodEnd: string | null;
}

export interface BillingStore {
  /** Writes the grant unless eventId was already processed. Returns true when written. */
  recordGrantOnce(eventId: string, grant: CreditGrant): Promise<boolean>;
  upsertSubscription(update: SubscriptionUpdate): Promise<void>;
}

export class InMemoryBillingStore implements BillingStore {
  readonly grants: Array<{ eventId: string; grant: CreditGrant }> = [];
  readonly subscriptions = new Map<string, SubscriptionUpdate>();
  private readonly processed = new Set<string>();

  async recordGrantOnce(eventId: string, grant: CreditGrant): Promise<boolean> {
    if (this.processed.has(eventId)) {
      return false;
    }
    this.processed.add(eventId);
    this.grants.push({ eventId, grant });
    return true;
  }

  async upsertSubscription(update: SubscriptionUpdate): Promise<void> {
    this.subscriptions.set(update.externalId, update);
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

export interface StripeProcessResult {
  handled: boolean;
  action: string;
  duplicate?: boolean;
}

function metadataValue(metadata: Stripe.Metadata | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function customerIdOf(customer: string | { id: string } | null | undefined): string | null {
  if (!customer) {
    return null;
  }
  return typeof customer === "string" ? customer : customer.id;
}

/** Finds the first line item price id on an invoice, across API shapes. */
function invoicePriceId(invoice: Stripe.Invoice): string | null {
  for (const line of invoice.lines?.data ?? []) {
    const priceDetails = line.pricing?.price_details?.price;
    if (typeof priceDetails === "string" && priceDetails.length > 0) {
      return priceDetails;
    }
    const legacyPrice = (line as unknown as { price?: { id?: string } }).price?.id;
    if (typeof legacyPrice === "string" && legacyPrice.length > 0) {
      return legacyPrice;
    }
  }
  return null;
}

function invoiceWorkspaceId(invoice: Stripe.Invoice): string | null {
  const subscriptionDetails =
    invoice.parent?.type === "subscription_details" ? invoice.parent.subscription_details : null;
  return (
    metadataValue(subscriptionDetails?.metadata ?? null, "workspaceId") ??
    metadataValue(invoice.metadata ?? null, "workspaceId")
  );
}

export async function processStripeEvent(
  event: Stripe.Event,
  table: PriceTable,
  store: BillingStore,
): Promise<StripeProcessResult> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const priceId = metadataValue(session.metadata, "priceId");
      const mapping = priceId ? table[priceId] : undefined;
      if (session.mode === "payment" && mapping?.kind === "topup") {
        const written = await store.recordGrantOnce(event.id, {
          workspaceId: metadataValue(session.metadata, "workspaceId") ?? session.client_reference_id,
          stripeCustomerId: customerIdOf(session.customer),
          credits: mapping.credits,
          reason: "topup",
          expiresMonths: mapping.expiresMonths,
        });
        return { handled: true, action: "topup_granted", duplicate: !written };
      }
      return { handled: true, action: "checkout_noted" };
    }

    case "invoice.paid": {
      const invoice = event.data.object;
      const priceId = invoicePriceId(invoice);
      const mapping = priceId ? table[priceId] : undefined;
      if (mapping?.kind === "tier") {
        const written = await store.recordGrantOnce(event.id, {
          workspaceId: invoiceWorkspaceId(invoice),
          stripeCustomerId: customerIdOf(invoice.customer),
          credits: mapping.creditsPerMonth,
          reason: "grant",
          expiresMonths: null,
        });
        return { handled: true, action: "cycle_credits_granted", duplicate: !written };
      }
      return { handled: true, action: "invoice_noted" };
    }

    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      const item = subscription.items?.data?.[0];
      const priceId = item?.price?.id ?? null;
      const mapping = priceId ? table[priceId] : undefined;
      const periodEnd = item?.current_period_end
        ? new Date(item.current_period_end * 1000).toISOString()
        : null;
      await store.upsertSubscription({
        workspaceId: metadataValue(subscription.metadata, "workspaceId"),
        stripeCustomerId: customerIdOf(subscription.customer),
        externalId: subscription.id,
        tier: mapping?.kind === "tier" ? mapping.tier : null,
        status: event.type === "customer.subscription.deleted" ? "canceled" : subscription.status,
        periodEnd,
      });
      return { handled: true, action: "subscription_synced" };
    }

    default:
      return { handled: false, action: "ignored" };
  }
}
