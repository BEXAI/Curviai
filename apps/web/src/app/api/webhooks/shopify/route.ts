/**
 * POST /api/webhooks/shopify
 * Verifies the base64 HMAC SHA256 body signature with a timing safe compare,
 * then routes the topic: products/create (auto pack stub),
 * app_subscriptions/update (dual billing) and the mandatory GDPR topics
 * customers/data_request, customers/redact and shop/redact.
 */

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

  const rawBody = await request.text();
  const hmacHeader = request.headers.get(SHOPIFY_HMAC_HEADER) ?? "";
  if (!verifyShopifyHmac(rawBody, hmacHeader, secret)) {
    return NextResponse.json({ error: "Invalid HMAC signature." }, { status: 401 });
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
    webhookId: request.headers.get(SHOPIFY_WEBHOOK_ID_HEADER) ?? `no-id-${Date.now()}`,
    payload,
    store: billingStore(),
  });
  return NextResponse.json(result.body, { status: result.status });
}
