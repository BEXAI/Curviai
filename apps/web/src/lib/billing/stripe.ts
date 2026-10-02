/**
 * Shared Stripe client for the billing routes. The API version is pinned to
 * the one the webhook parser and the SDK types were written against, so a
 * Stripe account default change can never reshape the objects we read.
 * Register the webhook endpoint on the same version (docs/STRIPE_SETUP.md).
 */

import Stripe from "stripe";
import { optionalEnv } from "@/lib/env";
import type { DuplicateRefund, StripeBillingActions, StripeLookup, StripeSubscriptionSummary } from "./stripe-webhook";

export const STRIPE_API_VERSION = "2025-08-27.basil" as const;

/** Throws when STRIPE_SECRET_KEY is unset; callers check hasStripeApiKey or isCheckoutOpen first. */
export function getStripe(): Stripe {
  const key = optionalEnv("STRIPE_SECRET_KEY");
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  return new Stripe(key, { apiVersion: STRIPE_API_VERSION });
}

/**
 * Stripe Tax is a founder decision (registrations must exist first), so
 * automatic tax and tax id collection switch on only when
 * STRIPE_TAX_ENABLED=1.
 */
export function isStripeTaxEnabled(): boolean {
  return optionalEnv("STRIPE_TAX_ENABLED") === "1";
}

/** Webhook lookups give up after this long, so a slow Stripe answer fails
 * the delivery instead of stretching it. */
export const STRIPE_LOOKUP_TIMEOUT_MS = 10_000;

/**
 * Per request options for every webhook lookup. The SDK retries a network
 * error or a timeout twice by default, which would stretch one lookup to
 * three timeouts plus backoff. A failed lookup fails the delivery instead
 * and Stripe's own webhook retry sends it again later, so one attempt,
 * bounded by the timeout, is all a lookup makes. The billing store also runs
 * these lookups before it opens a transaction, so no database connection or
 * lock waits on Stripe.
 */
export const STRIPE_LOOKUP_OPTIONS = {
  timeout: STRIPE_LOOKUP_TIMEOUT_MS,
  maxNetworkRetries: 0,
} as const satisfies Stripe.RequestOptions;

/** A 404 from Stripe: the object does not exist (for example it belongs to
 * another account or mode). Any other failure is thrown so Stripe retries. */
export function isStripeMissingResource(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const { statusCode, code } = error as { statusCode?: unknown; code?: unknown };
  return statusCode === 404 || code === "resource_missing";
}

/** Read only lookups the webhook needs to route refunds and disputes and to
 * read a subscription's current state. */
export function createStripeLookup(stripe: Stripe): StripeLookup {
  return {
    async invoiceIdForPaymentIntent(paymentIntentId: string): Promise<string | null> {
      const payments = await stripe.invoicePayments.list(
        {
          payment: { type: "payment_intent", payment_intent: paymentIntentId },
          limit: 1,
        },
        { ...STRIPE_LOOKUP_OPTIONS },
      );
      const invoice = payments.data[0]?.invoice;
      if (!invoice) {
        return null;
      }
      return typeof invoice === "string" ? invoice : (invoice.id ?? null);
    },

    async retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription | null> {
      try {
        return await stripe.subscriptions.retrieve(subscriptionId, {}, { ...STRIPE_LOOKUP_OPTIONS });
      } catch (error) {
        if (isStripeMissingResource(error)) {
          return null;
        }
        throw error;
      }
    },
  };
}

/** The Stripe error code for a refund of a payment already refunded in full. */
export function isAlreadyRefunded(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "charge_already_refunded");
}

/** Idempotency key of the refund for a duplicate subscription's payment. */
export function duplicateRefundKey(subscriptionId: string, index = 0): string {
  return index === 0 ? `curvi-dup-refund-${subscriptionId}` : `curvi-dup-refund-${subscriptionId}-${index}`;
}

function idOf(value: string | { id?: string } | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return typeof value === "string" ? value : (value.id ?? null);
}

/**
 * The writes the webhook makes to retire a duplicate subscription: list a
 * customer's subscriptions, refund the duplicate's latest invoice and cancel
 * it. Every call is bounded like the lookups; a failure fails the delivery
 * and Stripe's retry runs it again, which the refund idempotency key and the
 * already refunded check make safe.
 */
export function createStripeBillingActions(stripe: Stripe): StripeBillingActions {
  return {
    async listCustomerSubscriptions(customerId: string): Promise<StripeSubscriptionSummary[]> {
      const list = await stripe.subscriptions.list(
        { customer: customerId, status: "all", limit: 20 },
        { ...STRIPE_LOOKUP_OPTIONS },
      );
      return list.data.map((subscription) => ({
        id: subscription.id,
        status: subscription.status,
        created: subscription.created,
        customerId: idOf(subscription.customer),
        latestInvoiceId: idOf(subscription.latest_invoice),
      }));
    },

    async refundInvoice(subscriptionId: string, invoiceId: string): Promise<DuplicateRefund> {
      // Since 2025-03-31.basil an invoice names its payments through
      // InvoicePayment objects instead of invoice.payment_intent or charge.
      const payments = await stripe.invoicePayments.list(
        { invoice: invoiceId, status: "paid", limit: 10 },
        { ...STRIPE_LOOKUP_OPTIONS },
      );
      const refund: DuplicateRefund = { amount: 0, currency: null, refundIds: [] };
      let index = 0;
      for (const payment of payments.data) {
        const paymentIntent = idOf(payment.payment?.payment_intent);
        const charge = idOf(payment.payment?.charge);
        if (!paymentIntent && !charge) {
          continue;
        }
        const key = duplicateRefundKey(subscriptionId, index);
        index += 1;
        refund.currency = payment.currency ?? refund.currency;
        try {
          const created = await stripe.refunds.create(
            {
              ...(paymentIntent ? { payment_intent: paymentIntent } : { charge: charge ?? undefined }),
              reason: "duplicate",
              metadata: { subscriptionId, invoiceId, curviReason: "duplicate_subscription" },
            },
            { ...STRIPE_LOOKUP_OPTIONS, idempotencyKey: key },
          );
          refund.amount += created.amount;
          refund.refundIds.push(created.id);
        } catch (error) {
          if (!isAlreadyRefunded(error)) {
            throw error;
          }
          // Refunded by an earlier delivery whose idempotency key has been
          // pruned, or by hand in the Dashboard.
          refund.amount += payment.amount_paid ?? 0;
        }
      }
      return refund;
    },

    async cancelSubscription(subscriptionId: string): Promise<void> {
      try {
        await stripe.subscriptions.cancel(
          subscriptionId,
          { invoice_now: false, prorate: false },
          { ...STRIPE_LOOKUP_OPTIONS },
        );
      } catch (error) {
        if (isStripeMissingResource(error)) {
          return;
        }
        throw error;
      }
    },
  };
}
