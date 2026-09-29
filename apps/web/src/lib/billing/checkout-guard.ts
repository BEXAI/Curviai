/**
 * Keeps a workspace to one Stripe customer and one subscription, however
 * many tabs or clicks start a checkout (docs/STRIPE_SETUP.md, "Duplicate
 * subscription protection").
 *
 * 1. One customer per workspace, created before Checkout under an
 *    idempotency key tied to the workspace and stored only while the
 *    workspace has none. Checkout always gets `customer`, never
 *    customer_email or customer_creation, so it can never make another one.
 * 2. One open tier checkout at a time. Under a per workspace advisory lock,
 *    a tier purchase asks Stripe (not our rows, which the webhook writes
 *    later) whether the customer already has a subscription; if so the
 *    buyer goes to the plan change portal instead. Otherwise every open
 *    subscription mode Checkout Session of the customer is expired before
 *    the new one is created, so paying in an older tab fails at Stripe.
 *
 * The webhook backstop (stripe-webhook.ts retireDuplicateSubscriptions)
 * refunds and cancels anything that still slips through.
 */

import type Stripe from "stripe";
import { sql, type Db } from "@curvi/db";
import { createPlanChangePortalSession } from "./checkout";
import { STRIPE_LOOKUP_TIMEOUT_MS } from "./stripe";

/**
 * Per request options for the checkout calls. Bounded, because tier calls
 * run while the workspace's checkout lock is held; one network retry, which
 * the SDK makes safe for writes with an idempotency key.
 */
export const STRIPE_CHECKOUT_OPTIONS = {
  timeout: STRIPE_LOOKUP_TIMEOUT_MS,
  maxNetworkRetries: 1,
} as const satisfies Stripe.RequestOptions;

/** How long a second checkout for the same workspace waits for the first. */
export const CHECKOUT_LOCK_TIMEOUT = "30s";

/**
 * Subscription statuses that block a new tier Checkout. Each is a
 * subscription that exists in Stripe and bills, or may still bill, the
 * customer; incomplete covers a first payment still in progress.
 */
export const CHECKOUT_BLOCKING_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
  "past_due",
  "incomplete",
  "unpaid",
  "paused",
]);

export function customerIdempotencyKey(workspaceId: string): string {
  return `curvi-customer-${workspaceId}`;
}

export interface EnsureCustomerInput {
  workspaceId: string;
  /** The signed in user's email, shown on the customer in Stripe. */
  email: string | null;
  /** workspaces.stripe_customer_id as last read. */
  storedCustomerId: string | null;
  /** Stores the customer only if the workspace still has none and returns
   * whatever is stored afterwards. */
  claim: (customerId: string) => Promise<string | null>;
  /** Reads the stored customer again. */
  reread: () => Promise<string | null>;
}

/**
 * The workspace's Stripe customer, created and stored first when missing.
 * Two requests racing here send the same idempotency key, so Stripe returns
 * the same customer to both; if a request still gets another customer (the
 * key was pruned after 24 hours), the conditional store keeps the first
 * and both use it.
 */
export async function ensureStripeCustomer(stripe: Stripe, input: EnsureCustomerInput): Promise<string> {
  if (input.storedCustomerId) {
    return input.storedCustomerId;
  }
  let createdId: string;
  try {
    const customer = await stripe.customers.create(
      { ...(input.email ? { email: input.email } : {}), metadata: { workspaceId: input.workspaceId } },
      { ...STRIPE_CHECKOUT_OPTIONS, idempotencyKey: customerIdempotencyKey(input.workspaceId) },
    );
    createdId = customer.id;
  } catch (error) {
    // idempotency_key_in_use (the other request is creating it right now)
    // or another member's email under the same key: whatever the other
    // request stored is the customer.
    const stored = await input.reread();
    if (stored) {
      return stored;
    }
    throw error;
  }
  const stored = await input.claim(createdId);
  if (stored && stored !== createdId) {
    console.warn(
      JSON.stringify({
        msg: "billing: another request stored a different customer first, using it",
        workspaceId: input.workspaceId,
        kept: stored,
        unused: createdId,
      }),
    );
  }
  return stored ?? createdId;
}

/**
 * Runs `fn` while holding a transaction scoped advisory lock on the
 * workspace's checkout, so two tier checkouts for one workspace run one
 * after the other. Without a database (demo mode) it just runs `fn`.
 */
export async function withCheckoutLock<T>(db: Db | null, workspaceId: string, fn: () => Promise<T>): Promise<T> {
  if (!db) {
    return fn();
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local lock_timeout = '${CHECKOUT_LOCK_TIMEOUT}'`));
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`checkout:${workspaceId}`}))`);
    return fn();
  });
}

export interface TierCheckoutInput {
  customerId: string;
  priceId: string;
  /** Where the portal returns to. */
  returnUrl: string;
  params: Stripe.Checkout.SessionCreateParams;
}

export type TierCheckoutResult = { via: "portal"; url: string } | { via: "checkout"; url: string | null };

/**
 * Opens a tier purchase for a customer that Stripe says has no
 * subscription, or the plan change portal for one that has. Run it inside
 * withCheckoutLock.
 */
export async function openTierCheckout(stripe: Stripe, input: TierCheckoutInput): Promise<TierCheckoutResult> {
  const subscriptions = await stripe.subscriptions.list(
    { customer: input.customerId, status: "all", limit: 20 },
    { ...STRIPE_CHECKOUT_OPTIONS },
  );
  const existing = subscriptions.data.find((subscription) => CHECKOUT_BLOCKING_STATUSES.has(subscription.status));
  if (existing) {
    const url = await createPlanChangePortalSession(stripe, {
      customerId: input.customerId,
      subscriptionId: existing.id,
      priceId: input.priceId,
      returnUrl: input.returnUrl,
    });
    return { via: "portal", url };
  }

  const open = await stripe.checkout.sessions.list(
    { customer: input.customerId, status: "open", limit: 100 },
    { ...STRIPE_CHECKOUT_OPTIONS },
  );
  for (const session of open.data) {
    if (session.mode === "subscription") {
      // A failure here (for example the session was paid a moment ago)
      // fails this request instead of opening a second subscription.
      await stripe.checkout.sessions.expire(session.id, {}, { ...STRIPE_CHECKOUT_OPTIONS });
    }
  }

  const session = await stripe.checkout.sessions.create(input.params, { ...STRIPE_CHECKOUT_OPTIONS });
  return { via: "checkout", url: session.url };
}
