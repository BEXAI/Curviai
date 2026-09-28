/**
 * POST /api/billing/checkout
 * Creates a Stripe Checkout session for a tier subscription or a credit top
 * up. Price ids come from environment variables by name (see price-table).
 * Without Stripe env it answers 503 with a setup notice the UI shows inline.
 */

import { NextResponse } from "next/server";
import Stripe from "stripe";
import { z } from "zod";
import { tiers, topUps } from "@curvi/pipeline/seed";
import { isStripeConfigured, optionalEnv, siteUrl } from "@/lib/env";
import { priceIdForTier, priceIdForTopUp } from "@/lib/billing/price-table";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

const paidTierKeys = tiers.filter((t) => t.monthlyUsd > 0).map((t) => t.key);
const topUpCredits = topUps.map((t) => t.credits);

const CheckoutRequest = z.union([
  z.object({
    kind: z.literal("tier"),
    tier: z.string().refine((value) => paidTierKeys.includes(value as (typeof paidTierKeys)[number]), {
      message: "Unknown tier.",
    }),
    cadence: z.enum(["monthly", "annual"]),
  }),
  z.object({
    kind: z.literal("topup"),
    credits: z.number().refine((value) => topUpCredits.includes(value), { message: "Unknown top up." }),
  }),
]);

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const parsed = CheckoutRequest.safeParse(body);
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
        notice: "Card checkout is briefly unavailable. Email hello@curvi.ai and we will upgrade your plan right away.",
      },
      { status: 503 },
    );
  }

  const priceId =
    parsed.data.kind === "tier"
      ? priceIdForTier(parsed.data.tier as (typeof paidTierKeys)[number], parsed.data.cadence)
      : priceIdForTopUp(parsed.data.credits);
  if (!priceId) {
    return NextResponse.json(
      {
        error: "price_not_configured",
        notice: "This plan cannot be purchased online right now. Email hello@curvi.ai and we will set it up.",
      },
      { status: 503 },
    );
  }

  const services = getServices();
  const workspace = await services.ensureWorkspace();
  if (!workspace) {
    return NextResponse.json({ error: "Sign in to manage billing." }, { status: 401 });
  }

  const stripe = new Stripe(optionalEnv("STRIPE_SECRET_KEY") as string);
  const isSubscription = parsed.data.kind === "tier";
  const session = await stripe.checkout.sessions.create({
    mode: isSubscription ? "subscription" : "payment",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${siteUrl()}/app/billing?status=success`,
    cancel_url: `${siteUrl()}/app/billing?status=canceled`,
    client_reference_id: workspace.id,
    metadata: { workspaceId: workspace.id, priceId },
    ...(isSubscription
      ? { subscription_data: { metadata: { workspaceId: workspace.id } } }
      : {}),
  });

  return NextResponse.json({ url: session.url });
}
