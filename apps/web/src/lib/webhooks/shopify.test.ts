import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { tierByKey } from "@curvi/pipeline/seed";
import { InMemoryBillingStore } from "@/lib/billing/stripe-webhook";
import { routeShopifyTopic, SHOPIFY_GDPR_TOPICS, verifyShopifyHmac } from "./shopify";

const SECRET = "shpss_test_secret";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

describe("verifyShopifyHmac", () => {
  const body = JSON.stringify({ id: 123, title: "Copper bottle" });

  it("accepts the correct base64 HMAC", () => {
    expect(verifyShopifyHmac(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifyShopifyHmac(body + " ", sign(body), SECRET)).toBe(false);
  });

  it("rejects a signature made with another secret", () => {
    expect(verifyShopifyHmac(body, sign(body, "other_secret"), SECRET)).toBe(false);
  });

  it("rejects empty or malformed headers without throwing", () => {
    expect(verifyShopifyHmac(body, "", SECRET)).toBe(false);
    expect(verifyShopifyHmac(body, "not base64 at all!!", SECRET)).toBe(false);
    expect(verifyShopifyHmac(body, "AAAA", SECRET)).toBe(false);
  });
});

describe("routeShopifyTopic", () => {
  function context(topic: string, payload: Record<string, unknown> = {}) {
    return {
      topic,
      shopDomain: "demo.myshopify.com",
      webhookId: "wh_1",
      payload,
      store: new InMemoryBillingStore(),
      log: () => {},
    };
  }

  it("acknowledges every mandatory GDPR topic with a 200", async () => {
    for (const topic of SHOPIFY_GDPR_TOPICS) {
      const result = await routeShopifyTopic(context(topic));
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ acknowledged: true, topic });
    }
  });

  it("logs the GDPR acknowledgment", async () => {
    const lines: string[] = [];
    await routeShopifyTopic({ ...context("customers/redact"), log: (m) => lines.push(m) });
    expect(lines.some((line) => line.includes("gdpr acknowledged") && line.includes("customers/redact"))).toBe(
      true,
    );
  });

  it("answers products/create with the auto pack stub", async () => {
    const result = await routeShopifyTopic(context("products/create", { id: 42 }));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ acknowledged: true, action: "auto_pack_enqueue_stub" });
  });

  it("grants tier credits once for an active app subscription", async () => {
    const ctx = context("app_subscriptions/update", {
      app_subscription: {
        admin_graphql_api_id: "gid://shopify/AppSubscription/1",
        name: "Growth",
        status: "ACTIVE",
      },
    });
    await routeShopifyTopic(ctx);
    await routeShopifyTopic(ctx);
    expect(ctx.store.grants).toHaveLength(1);
    expect(ctx.store.grants[0].grant.credits).toBe(tierByKey("growth").creditsPerMonth);
    expect(ctx.store.subscriptions.get("gid://shopify/AppSubscription/1")).toMatchObject({
      tier: "growth",
      status: "active",
    });
  });

  it("acknowledges unknown topics without acting", async () => {
    const ctx = context("orders/create");
    const result = await routeShopifyTopic(ctx);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ action: "ignored" });
    expect(ctx.store.grants).toHaveLength(0);
  });
});
