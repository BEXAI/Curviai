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
 *
 * Every 2xx records webhook:stripe:last_success in platform_settings, which
 * /api/health compares with the last checkout (P20-01 stripe_webhook_quiet).
 * The billing reconciler (/api/cron/billing-reconcile, P20-02) replays any
 * event this route missed through the same processStripeEvent.
 */

import { readBodyLimited, WEBHOOK_MAX_BYTES } from "@/lib/http/read-body";
import { NextResponse } from "next/server";
import { hasStripeApiKey, optionalEnv, siteUrl } from "@/lib/env";
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
import { createActivationSender, dbEmailClaims, memoryEmailClaims, type EmailClaims } from "@/lib/billing/billing-email";
import { billingTransactionalSender } from "@/lib/billing/transactional-email";
import { recordStripeFunnel } from "@/lib/billing/funnel";
import { recordBillingEmailResult, recordBillingSignal, WEBHOOK_SUCCESS_KEY } from "@/lib/billing/signals";
import { recordStripeReferrals } from "@/lib/referrals/stripe";
import { getDb } from "@/lib/services/db";
import { isDbMode } from "@/lib/services";

export const dynamic = "force-dynamic";

function billingStore(): BillingStore {
  if (isDbMode()) {
    return new DbBillingStore(getDb(), "stripe");
  }
  return getInMemoryBillingStore();
}

/** Demo mode keeps its activation claims in memory for the process. */
let demoClaims: EmailClaims | null = null;

/** The activation email on a first paid subscription invoice (P20-07). */
function activation() {
  const claims = isDbMode() ? dbEmailClaims(getDb()) : (demoClaims ??= memoryEmailClaims());
  return createActivationSender({
    claims,
    readEnv: optionalEnv,
    siteUrl: siteUrl(),
    send: isDbMode() ? billingTransactionalSender(getDb(), optionalEnv) : undefined,
    // billing:email:last_result, for billing_email_failing in /api/health.
    recordResult: isDbMode() ? (result) => recordBillingEmailResult(getDb(), result) : undefined,
  });
}

function processDeps(): StripeProcessDeps {
  if (!hasStripeApiKey()) {
    return { activation: activation() };
  }
  const stripe = getStripe();
  return { lookup: createStripeLookup(stripe), actions: createStripeBillingActions(stripe), activation: activation() };
}

/** Health's stripe_webhook_quiet reads when the webhook last answered 2xx
 * (P20-01). Never throws. */
async function recordWebhookSuccess(): Promise<void> {
  if (isDbMode()) {
    await recordBillingSignal(getDb(), WEBHOOK_SUCCESS_KEY);
  }
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
    const table = buildPriceTable();
    const result = await processStripeEvent(event, table, billingStore(), processDeps());
    if (isDbMode()) {
      // The server side funnel (P18-02, lib/billing/funnel.ts). Never throws.
      await recordStripeFunnel(getDb(), event, result, table);
      // Referral rewards and their clawback (P18-24, lib/referrals/stripe.ts).
      // Never throws; a failed step answers 500 below so Stripe delivers the
      // event again (billing and the referral steps are both idempotent).
      const referrals = await recordStripeReferrals(getDb(), event, result, table);
      if (referrals.failed) {
        return NextResponse.json({ error: "referral_failed", eventId: event.id }, { status: 500 });
      }
    }
    await recordWebhookSuccess();
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
