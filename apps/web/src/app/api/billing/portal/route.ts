/**
 * POST /api/billing/portal
 * Returns a Stripe customer portal session url. Needs Stripe env plus a
 * workspace with a Stripe customer; otherwise answers 503 with a notice.
 */

import { NextResponse } from "next/server";
import Stripe from "stripe";
import { isStripeConfigured, optionalEnv, siteUrl } from "@/lib/env";
import { getServices, isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  if (!isStripeConfigured()) {
    return NextResponse.json(
      {
        error: "billing_not_configured",
        notice: "The customer portal needs Stripe. Set STRIPE_SECRET_KEY to enable it.",
      },
      { status: 503 },
    );
  }

  const services = getServices();
  const workspace = await services.ensureWorkspace();
  if (!workspace) {
    return NextResponse.json({ error: "Sign in to manage billing." }, { status: 401 });
  }

  let customerId: string | null = null;
  if (isDbMode()) {
    const row = await getDb().query.workspaces.findFirst({
      where: (t, { eq }) => eq(t.id, workspace.id),
    });
    customerId = row?.stripeCustomerId ?? null;
  }
  if (!customerId) {
    return NextResponse.json(
      {
        error: "no_customer",
        notice: "This workspace has no Stripe customer yet. Complete a checkout first.",
      },
      { status: 503 },
    );
  }

  const stripe = new Stripe(optionalEnv("STRIPE_SECRET_KEY") as string);
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${siteUrl()}/app/billing`,
  });
  return NextResponse.json({ url: session.url });
}
