/**
 * Shopify webhook verification and topic routing. Shopify signs the raw body
 * with HMAC SHA256 keyed on the app secret and sends it base64 encoded in
 * X-Shopify-Hmac-Sha256. The compare is timing safe. Topic handling covers
 * products/create (auto pack enqueue stub), app_subscriptions/update (dual
 * billing grants through the shared BillingStore) and the three mandatory
 * GDPR topics, which are acknowledged and logged.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { tiers, type TierKey } from "@curvi/pipeline/seed";
import type { BillingStore } from "@/lib/billing/stripe-webhook";

export const SHOPIFY_HMAC_HEADER = "x-shopify-hmac-sha256";
export const SHOPIFY_TOPIC_HEADER = "x-shopify-topic";
export const SHOPIFY_WEBHOOK_ID_HEADER = "x-shopify-webhook-id";
export const SHOPIFY_SHOP_HEADER = "x-shopify-shop-domain";

/** Timing safe verification of the base64 HMAC SHA256 body signature. */
export function verifyShopifyHmac(rawBody: string, hmacHeader: string, secret: string): boolean {
  if (!hmacHeader || !secret) {
    return false;
  }
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  let claimed: Buffer;
  try {
    claimed = Buffer.from(hmacHeader, "base64");
  } catch {
    return false;
  }
  if (claimed.length !== digest.length) {
    return false;
  }
  return timingSafeEqual(digest, claimed);
}

export const SHOPIFY_GDPR_TOPICS = ["customers/data_request", "customers/redact", "shop/redact"] as const;

export interface ShopifyTopicResult {
  status: number;
  body: Record<string, unknown>;
}

export interface ShopifyTopicContext {
  topic: string;
  shopDomain: string;
  webhookId: string;
  payload: Record<string, unknown>;
  store: BillingStore;
  log?: (message: string) => void;
}

function planNameToTier(planName: unknown): TierKey | null {
  if (typeof planName !== "string") {
    return null;
  }
  const normalized = planName.trim().toLowerCase();
  return tiers.find((t) => t.key === normalized)?.key ?? null;
}

export async function routeShopifyTopic(ctx: ShopifyTopicContext): Promise<ShopifyTopicResult> {
  const log = ctx.log ?? ((message: string) => console.log(message));

  if ((SHOPIFY_GDPR_TOPICS as readonly string[]).includes(ctx.topic)) {
    log(`shopify gdpr acknowledged: topic=${ctx.topic} shop=${ctx.shopDomain} webhookId=${ctx.webhookId}`);
    return { status: 200, body: { acknowledged: true, topic: ctx.topic } };
  }

  switch (ctx.topic) {
    case "products/create": {
      // Auto pack enqueue stub: the worker wiring lands with the Shopify app
      // phase. Acknowledging keeps the webhook subscription healthy.
      const productId = ctx.payload["id"] ?? null;
      log(`shopify auto pack stub: shop=${ctx.shopDomain} productId=${String(productId)}`);
      return { status: 200, body: { acknowledged: true, action: "auto_pack_enqueue_stub" } };
    }

    case "app_subscriptions/update": {
      const subscription = (ctx.payload["app_subscription"] ?? {}) as Record<string, unknown>;
      const status = typeof subscription["status"] === "string" ? subscription["status"] : "unknown";
      const tier = planNameToTier(subscription["name"]);
      const externalId = typeof subscription["admin_graphql_api_id"] === "string"
        ? subscription["admin_graphql_api_id"]
        : `shopify:${ctx.shopDomain}`;
      await ctx.store.upsertSubscription({
        workspaceId: null,
        stripeCustomerId: null,
        externalId,
        tier,
        status: status.toLowerCase(),
        periodEnd: null,
      });
      if (status.toUpperCase() === "ACTIVE" && tier) {
        const credits = tiers.find((t) => t.key === tier)?.creditsPerMonth ?? 0;
        if (credits > 0) {
          await ctx.store.recordGrantOnce(ctx.webhookId, {
            workspaceId: null,
            stripeCustomerId: null,
            credits,
            reason: "grant",
            expiresMonths: null,
          });
        }
      }
      return { status: 200, body: { acknowledged: true, action: "subscription_synced" } };
    }

    default:
      log(`shopify topic ignored: ${ctx.topic}`);
      return { status: 200, body: { acknowledged: true, action: "ignored" } };
  }
}
