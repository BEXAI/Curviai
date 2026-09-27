/**
 * POST /api/webhooks/stripe
 * Verifies the Stripe signature with the SDK, then processes the event with
 * idempotent grant handling. Without STRIPE_WEBHOOK_SECRET it answers 503
 * with a setup notice.
 */

import { NextResponse } from "next/server";
import { optionalEnv } from "@/lib/env";
import { buildPriceTable } from "@/lib/billing/price-table";
import {
  getInMemoryBillingStore,
  processStripeEvent,
  verifyStripeEvent,
  type BillingStore,
} from "@/lib/billing/stripe-webhook";
import { DbBillingStore } from "@/lib/billing/db-store";
import { getDb } from "@/lib/services/db";
import { isDbMode } from "@/lib/services";

export const dynamic = "force-dynamic";

function billingStore(): BillingStore {
  if (isDbMode()) {
    return new DbBillingStore(getDb(), "stripe");
  }
  return getInMemoryBillingStore();
}

export async function POST(request: Request): Promise<NextResponse> {
  const secret = optionalEnv("STRIPE_WEBHOOK_SECRET");
  if (!secret) {
    return NextResponse.json(
      {
        error: "stripe_not_configured",
        notice: "Set STRIPE_WEBHOOK_SECRET to enable Stripe webhooks.",
      },
      { status: 503 },
    );
  }
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing Stripe-Signature header." }, { status: 400 });
  }
  const rawBody = await request.text();

  let event;
  try {
    event = verifyStripeEvent(rawBody, signature, secret);
  } catch {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  const result = await processStripeEvent(event, buildPriceTable(), billingStore());
  return NextResponse.json({ received: true, ...result });
}
