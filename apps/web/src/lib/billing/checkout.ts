/**
 * Builds Stripe Checkout and Customer Portal requests. Pure where possible so
 * the exact parameters are unit tested without the network.
 *
 * Checkout always:
 * - uses the workspace's one Stripe customer, created before Checkout when
 *   the workspace has none (checkout-guard.ts), so Checkout never makes a
 *   second customer for the same workspace,
 * - accepts promotion codes,
 * - requires agreement to the terms (the terms URL must be set in the
 *   Stripe Dashboard public details, see docs/STRIPE_SETUP.md),
 * - tags the session, the subscription and the payment with the workspace,
 *   plan, cadence and source.
 * Automatic tax and tax id collection switch on only with STRIPE_TAX_ENABLED=1.
 */

import type Stripe from "stripe";
import type { CheckoutSource } from "./intent";
import type { BillingCadence, PaidTierKey } from "./plans";

export type CheckoutPurchase =
  | { kind: "tier"; tier: PaidTierKey; cadence: BillingCadence }
  | { kind: "topup"; credits: number };

export interface CheckoutParamsInput {
  purchase: CheckoutPurchase;
  priceId: string;
  workspaceId: string;
  siteUrl: string;
  source: CheckoutSource;
  /** workspaces.stripe_customer_id, created first when it was missing. */
  customerId: string;
  taxEnabled: boolean;
}

export function checkoutReturnUrls(siteUrl: string, purchase: CheckoutPurchase): { success: string; cancel: string } {
  return {
    // Stripe fills in {CHECKOUT_SESSION_ID}, so the billing page can tell
    // when the webhook has granted this exact purchase.
    success: `${siteUrl}/app/billing?status=success&kind=${purchase.kind}&session_id={CHECKOUT_SESSION_ID}`,
    cancel: `${siteUrl}/app/billing?status=canceled`,
  };
}

export function buildCheckoutParams(input: CheckoutParamsInput): Stripe.Checkout.SessionCreateParams {
  const { purchase, priceId, workspaceId, siteUrl, source, customerId, taxEnabled } = input;
  const isSubscription = purchase.kind === "tier";
  const urls = checkoutReturnUrls(siteUrl, purchase);

  const metadata: Record<string, string> = {
    workspaceId,
    priceId,
    kind: purchase.kind,
    plan: purchase.kind === "tier" ? purchase.tier : "topup",
    cadence: purchase.kind === "tier" ? purchase.cadence : "one_time",
    source,
  };
  if (purchase.kind === "topup") {
    metadata.credits = String(purchase.credits);
  }

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: isSubscription ? "subscription" : "payment",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: urls.success,
    cancel_url: urls.cancel,
    client_reference_id: workspaceId,
    // Always the workspace's own customer: never customer_email or
    // customer_creation, which would let Checkout make another customer.
    customer: customerId,
    metadata,
    allow_promotion_codes: true,
    consent_collection: { terms_of_service: "required" },
    custom_text: {
      terms_of_service_acceptance: {
        message: `I agree to the [Terms of Service](${siteUrl}/terms).`,
      },
    },
  };

  if (isSubscription) {
    params.subscription_data = {
      metadata: {
        workspaceId,
        plan: metadata.plan,
        cadence: metadata.cadence,
        source,
      },
    };
  } else {
    // An invoice so business buyers have a document for their books.
    params.invoice_creation = {
      enabled: true,
      invoice_data: { metadata: { workspaceId, credits: metadata.credits ?? "" } },
    };
    params.payment_intent_data = { metadata: { workspaceId, credits: metadata.credits ?? "" } };
  }

  if (taxEnabled) {
    params.automatic_tax = { enabled: true };
    params.billing_address_collection = "required";
    params.tax_id_collection = { enabled: true };
    // An existing customer must let Checkout save the address and business
    // name it collects, or Stripe rejects tax and tax id collection.
    params.customer_update = { address: "auto", name: "auto" };
  }

  return params;
}

export interface PlanChangePortalInput {
  customerId: string;
  subscriptionId: string;
  /** The subscription item to move to the new price, when known. */
  subscriptionItemId: string | null;
  priceId: string;
  returnUrl: string;
}

/**
 * An existing subscriber who picks another plan confirms the change in the
 * Customer Portal instead of opening a second subscription (Update.md 1.5).
 * With the item id the portal opens straight on the confirm step for the
 * chosen price; without it the portal shows the plan picker.
 */
export function buildPlanChangePortalParams(input: PlanChangePortalInput): Stripe.BillingPortal.SessionCreateParams {
  const afterCompletion: Stripe.BillingPortal.SessionCreateParams.FlowData.AfterCompletion = {
    type: "redirect",
    redirect: { return_url: `${input.returnUrl}?status=success&kind=plan_change` },
  };
  if (input.subscriptionItemId) {
    return {
      customer: input.customerId,
      return_url: input.returnUrl,
      flow_data: {
        type: "subscription_update_confirm",
        subscription_update_confirm: {
          subscription: input.subscriptionId,
          items: [{ id: input.subscriptionItemId, price: input.priceId, quantity: 1 }],
        },
        after_completion: afterCompletion,
      },
    };
  }
  return {
    customer: input.customerId,
    return_url: input.returnUrl,
    flow_data: {
      type: "subscription_update",
      subscription_update: { subscription: input.subscriptionId },
      after_completion: afterCompletion,
    },
  };
}

/**
 * Opens the portal on the plan change for an existing subscriber. Falls back
 * from the confirm step to the plan picker, then to the portal home, so a
 * portal configuration that lacks plan switching still lands somewhere useful.
 */
export async function createPlanChangePortalSession(
  stripe: Stripe,
  input: Omit<PlanChangePortalInput, "subscriptionItemId">,
): Promise<string> {
  let subscriptionItemId: string | null = null;
  try {
    const subscription = await stripe.subscriptions.retrieve(input.subscriptionId);
    const items = subscription.items?.data ?? [];
    subscriptionItemId = items.length === 1 ? (items[0]?.id ?? null) : null;
    if (items.length === 1 && items[0]?.price?.id === input.priceId) {
      // Already on this price: the portal home shows the current plan.
      const home = await stripe.billingPortal.sessions.create({ customer: input.customerId, return_url: input.returnUrl });
      return home.url;
    }
  } catch (error) {
    console.warn(JSON.stringify({ msg: "billing: subscription lookup failed", error: String(error) }));
  }

  const attempts: Stripe.BillingPortal.SessionCreateParams[] = [];
  if (subscriptionItemId) {
    attempts.push(buildPlanChangePortalParams({ ...input, subscriptionItemId }));
  }
  attempts.push(buildPlanChangePortalParams({ ...input, subscriptionItemId: null }));
  attempts.push({ customer: input.customerId, return_url: input.returnUrl });

  let lastError: unknown = null;
  for (const params of attempts) {
    try {
      const session = await stripe.billingPortal.sessions.create(params);
      return session.url;
    } catch (error) {
      lastError = error;
      console.warn(
        JSON.stringify({
          msg: "billing: portal flow rejected, trying the next one",
          flow: params.flow_data?.type ?? "home",
          error: String(error),
        }),
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not open the customer portal.");
}
