/**
 * Shared Stripe client for the billing routes. The API version is pinned to
 * the one the webhook parser and the SDK types were written against, so a
 * Stripe account default change can never reshape the objects we read.
 * Register the webhook endpoint on the same version (docs/STRIPE_SETUP.md).
 */

import Stripe from "stripe";
import { optionalEnv } from "@/lib/env";
import type { StripeLookup } from "./stripe-webhook";

export const STRIPE_API_VERSION = "2025-08-27.basil" as const;

/** Throws when STRIPE_SECRET_KEY is unset; callers check isStripeConfigured first. */
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
 * the delivery (Stripe retries it) instead of holding a database lock. */
export const STRIPE_LOOKUP_TIMEOUT_MS = 10_000;

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
        { timeout: STRIPE_LOOKUP_TIMEOUT_MS },
      );
      const invoice = payments.data[0]?.invoice;
      if (!invoice) {
        return null;
      }
      return typeof invoice === "string" ? invoice : (invoice.id ?? null);
    },

    async retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription | null> {
      try {
        return await stripe.subscriptions.retrieve(subscriptionId, {}, { timeout: STRIPE_LOOKUP_TIMEOUT_MS });
      } catch (error) {
        if (isStripeMissingResource(error)) {
          return null;
        }
        throw error;
      }
    },
  };
}
