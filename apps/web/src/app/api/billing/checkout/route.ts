/**
 * POST /api/billing/checkout
 * Starts a Stripe Checkout session for a tier subscription or a credit top
 * up, or, for a workspace that already has a subscription, opens the Customer
 * Portal on the plan change so no second subscription is ever created.
 *
 * Answers:
 * - 401 signed out, 403 for the client role (plan 4.3, Update.md 4.4).
 * - 503 billing_not_configured when Stripe has no keys; the billing page
 *   shows an honest notice and a request button instead of calling this.
 * - 200 { url, via: "checkout" | "portal" } otherwise.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { topUps } from "@curvi/pipeline/seed";
import { isStripeConfigured, siteUrl } from "@/lib/env";
import { BILLING_FORBIDDEN_NOTICE, canManageBilling } from "@/lib/billing/access";
import { hasOpenSubscription, loadBillingAccount } from "@/lib/billing/account";
import { buildCheckoutParams, createPlanChangePortalSession, type CheckoutPurchase } from "@/lib/billing/checkout";
import { CHECKOUT_SOURCES } from "@/lib/billing/intent";
import { isPaidTierKey, type PaidTierKey } from "@/lib/billing/plans";
import { priceIdForTier, priceIdForTopUp } from "@/lib/billing/price-table";
import { getStripe, isStripeTaxEnabled } from "@/lib/billing/stripe";
import { readJsonCapped } from "@/lib/http/json-body";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { resolveSignedIn } from "@/lib/http/services";
import { isDbMode } from "@/lib/services";
import { getSessionUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const topUpCredits = topUps.map((t) => t.credits);

const Source = z.enum(CHECKOUT_SOURCES).default("billing");

const CheckoutRequest = z.union([
  z.object({
    kind: z.literal("tier"),
    tier: z.string().refine((value) => isPaidTierKey(value), { message: "Unknown tier." }),
    cadence: z.enum(["monthly", "annual"]),
    source: Source,
  }),
  z.object({
    kind: z.literal("topup"),
    credits: z.number().refine((value) => topUpCredits.includes(value), { message: "Unknown top up." }),
    source: Source,
  }),
]);

const STRIPE_ERROR_NOTICE = "Stripe could not open checkout just now. Try again in a minute.";

export async function POST(request: Request): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const resolved = await resolveSignedIn("Sign in to manage billing.", { ensure: true });
  if ("response" in resolved) {
    return resolved.response;
  }
  const { workspace } = resolved;
  if (!canManageBilling(workspace.role)) {
    return NextResponse.json({ error: "billing_forbidden", notice: BILLING_FORBIDDEN_NOTICE }, { status: 403 });
  }

  const body = await readJsonCapped(request);
  if (!body.ok) {
    return body.response;
  }
  const parsed = CheckoutRequest.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request.", issues: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }

  if (!isStripeConfigured()) {
    return NextResponse.json(
      {
        error: "billing_not_configured",
        notice: "Card payments are not open yet. Use Request this plan on the Billing page and we will email you when they open.",
      },
      { status: 503 },
    );
  }

  const data = parsed.data;
  const purchase: CheckoutPurchase =
    data.kind === "tier"
      ? { kind: "tier", tier: data.tier as PaidTierKey, cadence: data.cadence }
      : { kind: "topup", credits: data.credits };
  const priceId =
    purchase.kind === "tier" ? priceIdForTier(purchase.tier, purchase.cadence) : priceIdForTopUp(purchase.credits);
  if (!priceId) {
    return NextResponse.json(
      {
        error: "price_not_configured",
        notice: "This option cannot be bought online yet. Email hello@curvi.ai and we will set it up.",
      },
      { status: 503 },
    );
  }

  const account = await loadBillingAccount(workspace.id);
  const stripe = getStripe();

  if (purchase.kind === "tier" && hasOpenSubscription(account)) {
    const subscriptionId = account.subscription?.externalId ?? null;
    if (!account.stripeCustomerId || !subscriptionId) {
      return NextResponse.json(
        {
          error: "subscription_exists",
          notice: "This workspace already has a subscription. Email hello@curvi.ai and we will change the plan for you.",
        },
        { status: 409 },
      );
    }
    try {
      const url = await createPlanChangePortalSession(stripe, {
        customerId: account.stripeCustomerId,
        subscriptionId,
        priceId,
        returnUrl: `${siteUrl()}/app/billing`,
      });
      return NextResponse.json({ url, via: "portal" });
    } catch (error) {
      console.error(JSON.stringify({ msg: "billing: plan change portal failed", workspaceId: workspace.id, error: String(error) }));
      return NextResponse.json({ error: "stripe_error", notice: STRIPE_ERROR_NOTICE }, { status: 502 });
    }
  }

  const email = account.stripeCustomerId || !isDbMode() ? null : ((await getSessionUser())?.email ?? null);
  const params = buildCheckoutParams({
    purchase,
    priceId,
    workspaceId: workspace.id,
    siteUrl: siteUrl(),
    source: data.source,
    customerId: account.stripeCustomerId,
    customerEmail: email,
    taxEnabled: isStripeTaxEnabled(),
  });

  try {
    const session = await stripe.checkout.sessions.create(params);
    return NextResponse.json({ url: session.url, via: "checkout" });
  } catch (error) {
    console.error(JSON.stringify({ msg: "billing: checkout session failed", workspaceId: workspace.id, error: String(error) }));
    return NextResponse.json({ error: "stripe_error", notice: STRIPE_ERROR_NOTICE }, { status: 502 });
  }
}
