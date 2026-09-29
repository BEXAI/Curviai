/**
 * POST /api/webhooks/stripe
 * Verifies the Stripe signature with the SDK, then processes the event with
 * idempotent grant handling. Without STRIPE_WEBHOOK_SECRET it answers 503
 * with a setup notice.
 *
 * Any processing error answers 500 so Stripe retries (every handler is
 * idempotent, so a retry never double grants). An unroutable event, one with
 * no workspace and no linked customer, is logged loudly and retried the same
 * way; link the customer or fix the metadata, then resend it from the Stripe
 * Dashboard if the retries ran out (docs/STRIPE_SETUP.md).
 */

import { readBodyLimited, WEBHOOK_MAX_BYTES } from "@/lib/http/read-body";
import { NextResponse } from "next/server";
import { isStripeConfigured, optionalEnv } from "@/lib/env";
import { buildPriceTable } from "@/lib/billing/price-table";
import { createStripeBillingActions, createStripeLookup, getStripe } from "@/lib/billing/stripe";
import {
  getInMemoryBillingStore,
  processStripeEvent,
  UnroutableBillingEventError,
  verifyStripeEvent,
  type BillingStore,
  type StripeProcessDeps,
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

function processDeps(): StripeProcessDeps {
  if (!isStripeConfigured()) {
    return {};
  }
  const stripe = getStripe();
  return { lookup: createStripeLookup(stripe), actions: createStripeBillingActions(stripe) };
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
  // Stripe events are a few kilobytes; the cap only stops an oversized body
  // from being buffered before the signature check.
  const body = await readBodyLimited(request, WEBHOOK_MAX_BYTES);
  if (!body.ok) {
    return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
  }
  const rawBody = body.text;

  let event;
  try {
    event = verifyStripeEvent(rawBody, signature, secret);
  } catch {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  try {
    const result = await processStripeEvent(event, buildPriceTable(), billingStore(), processDeps());
    return NextResponse.json({ received: true, ...result });
  } catch (error) {
    const unroutable = error instanceof UnroutableBillingEventError;
    console.error(
      JSON.stringify({
        msg: unroutable ? "stripe webhook: unroutable event, Stripe will retry" : "stripe webhook: processing failed",
        eventId: event.id,
        type: event.type,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json(
      { error: unroutable ? "unroutable_event" : "processing_failed", eventId: event.id },
      { status: 500 },
    );
  }
}
