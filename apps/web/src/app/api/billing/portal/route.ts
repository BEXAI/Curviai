/**
 * POST /api/billing/portal
 * Returns a Stripe Customer Portal session url for card updates, invoices,
 * plan changes and cancellation.
 *
 * Answers 401 signed out, 403 for the client role (plan 4.3, Update.md 4.4),
 * 503 when Stripe has no keys, 409 when the workspace has never paid (no
 * Stripe customer yet), 502 when Stripe rejects the request.
 */

import { NextResponse } from "next/server";
import { isStripeConfigured, siteUrl } from "@/lib/env";
import { BILLING_FORBIDDEN_NOTICE, canManageBilling } from "@/lib/billing/access";
import { loadBillingAccount } from "@/lib/billing/account";
import { getStripe } from "@/lib/billing/stripe";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { resolveSignedIn } from "@/lib/http/services";

export const dynamic = "force-dynamic";

const NO_CUSTOMER_NOTICE =
  "Start a plan first. The customer portal opens after your first payment, for cards, invoices and plan changes.";

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
  if (!isStripeConfigured()) {
    return NextResponse.json(
      {
        error: "billing_not_configured",
        notice: "Card payments are not open yet, so there is nothing to manage here. Email hello@curvi.ai for any billing question.",
      },
      { status: 503 },
    );
  }

  const account = await loadBillingAccount(workspace.id);
  if (!account.stripeCustomerId) {
    // Not a server fault: the workspace has never paid, so Stripe has no
    // customer to open a portal for (Update.md 6.8).
    return NextResponse.json({ error: "no_customer", notice: NO_CUSTOMER_NOTICE }, { status: 409 });
  }

  try {
    const session = await getStripe().billingPortal.sessions.create({
      customer: account.stripeCustomerId,
      return_url: `${siteUrl()}/app/billing`,
    });
    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error(JSON.stringify({ msg: "billing: portal session failed", workspaceId: workspace.id, error: String(error) }));
    return NextResponse.json(
      { error: "stripe_error", notice: "Stripe could not open the portal just now. Try again in a minute." },
      { status: 502 },
    );
  }
}
