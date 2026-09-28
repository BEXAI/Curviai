/**
 * POST /api/webhooks/shopify
 * Verifies the base64 HMAC SHA256 body signature with a timing safe compare,
 * then routes the topic: products/create (auto pack stub),
 * app_subscriptions/update (dual billing) and the mandatory GDPR topics
 * customers/data_request, customers/redact and shop/redact.
 */

import { readBodyLimited, WEBHOOK_MAX_BYTES } from "@/lib/http/read-body";
import { NextResponse } from "next/server";
import { optionalEnv } from "@/lib/env";
import { getInMemoryBillingStore, type BillingStore } from "@/lib/billing/stripe-webhook";
import { DbBillingStore } from "@/lib/billing/db-store";
import { getDb } from "@/lib/services/db";
import { isDbMode } from "@/lib/services";
import {
  routeShopifyTopic,
  SHOPIFY_HMAC_HEADER,
  SHOPIFY_SHOP_HEADER,
  SHOPIFY_TOPIC_HEADER,
  SHOPIFY_WEBHOOK_ID_HEADER,
  verifyShopifyHmac,
} from "@/lib/webhooks/shopify";

export const dynamic = "force-dynamic";

function billingStore(): BillingStore {
  if (isDbMode()) {
    return new DbBillingStore(getDb(), "shopify");
  }
  return getInMemoryBillingStore();
}

export async function POST(request: Request): Promise<NextResponse> {
  const secret = optionalEnv("SHOPIFY_API_SECRET");
  if (!secret) {
    return NextResponse.json(
      {
        error: "shopify_not_configured",
        notice: "Set SHOPIFY_API_SECRET to enable Shopify webhooks.",
      },
      { status: 503 },
    );
  }

  const body = await readBodyLimited(request, WEBHOOK_MAX_BYTES);
  if (!body.ok) {
    return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
  }
  const rawBody = body.text;
  const hmacHeader = request.headers.get(SHOPIFY_HMAC_HEADER) ?? "";
  if (!verifyShopifyHmac(rawBody, hmacHeader, secret)) {
    return NextResponse.json({ error: "Invalid HMAC signature." }, { status: 401 });
  }

  // Shopify sends a delivery id with every webhook; without it the delivery
  // cannot be deduplicated, so it is refused rather than keyed on the clock.
  const webhookId = request.headers.get(SHOPIFY_WEBHOOK_ID_HEADER);
  if (!webhookId) {
    return NextResponse.json({ error: "Missing webhook id header." }, { status: 400 });
  }

  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed && typeof parsed === "object") {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    // GDPR probes may send empty bodies; verification already passed.
  }

  const result = await routeShopifyTopic({
    topic: request.headers.get(SHOPIFY_TOPIC_HEADER) ?? "",
    shopDomain: request.headers.get(SHOPIFY_SHOP_HEADER) ?? "unknown",
    webhookId,
    payload,
    store: billingStore(),
  });
  return NextResponse.json(result.body, { status: result.status });
}
