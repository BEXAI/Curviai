import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { tierByKey, topUps } from "@curvi/pipeline/seed";
import { buildPriceTable, tierPriceEnvName, topUpPriceEnvName } from "./price-table";
import {
  InMemoryBillingStore,
  processStripeEvent,
  verifyStripeEvent,
} from "./stripe-webhook";

const SECRET = "whsec_test_secret";
const stripe = new Stripe("sk_test_placeholder");

const ENV: Record<string, string> = {
  [tierPriceEnvName("starter", "monthly")]: "price_starter_monthly",
  [tierPriceEnvName("growth", "monthly")]: "price_growth_monthly",
  [topUpPriceEnvName(100)]: "price_topup_100",
};

const table = buildPriceTable((name) => ENV[name]);

function signedEvent(payloadObject: Record<string, unknown>): { payload: string; header: string } {
  const payload = JSON.stringify(payloadObject);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return { payload, header };
}

function verify(payloadObject: Record<string, unknown>): Stripe.Event {
  const { payload, header } = signedEvent(payloadObject);
  return verifyStripeEvent(payload, header, SECRET);
}

describe("verifyStripeEvent", () => {
  it("accepts a header generated with generateTestHeaderString", () => {
    const event = verify({ id: "evt_ok", type: "checkout.session.completed", data: { object: {} } });
    expect(event.id).toBe("evt_ok");
  });

  it("rejects a tampered payload", () => {
    const { header } = signedEvent({ id: "evt_1", type: "invoice.paid", data: { object: {} } });
    const tampered = JSON.stringify({ id: "evt_2", type: "invoice.paid", data: { object: {} } });
    expect(() => verifyStripeEvent(tampered, header, SECRET)).toThrow();
  });

  it("rejects the wrong secret", () => {
    const { payload, header } = signedEvent({ id: "evt_1", type: "invoice.paid", data: { object: {} } });
    expect(() => verifyStripeEvent(payload, header, "whsec_other")).toThrow();
  });
});

describe("price table", () => {
  it("maps env named price ids to seed tiers and top ups", () => {
    expect(table["price_starter_monthly"]).toEqual({
      kind: "tier",
      tier: "starter",
      cadence: "monthly",
      creditsPerMonth: tierByKey("starter").creditsPerMonth,
    });
    expect(table["price_topup_100"]).toEqual({
      kind: "topup",
      credits: 100,
      expiresMonths: topUps.find((t) => t.credits === 100)?.expiresMonths,
    });
    expect(table["price_unset"]).toBeUndefined();
  });
});

describe("processStripeEvent", () => {
  it("grants a top up once for checkout.session.completed and dedupes the retry", async () => {
    const store = new InMemoryBillingStore();
    const event = verify({
      id: "evt_checkout_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          object: "checkout.session",
          mode: "payment",
          customer: "cus_1",
          metadata: { workspaceId: "ws_1", priceId: "price_topup_100" },
        },
      },
    });

    const first = await processStripeEvent(event, table, store);
    expect(first).toMatchObject({ handled: true, action: "topup_granted", duplicate: false });
    const second = await processStripeEvent(event, table, store);
    expect(second).toMatchObject({ handled: true, action: "topup_granted", duplicate: true });

    expect(store.grants).toHaveLength(1);
    expect(store.grants[0].grant).toMatchObject({
      workspaceId: "ws_1",
      credits: 100,
      reason: "topup",
    });
  });

  it("grants cycle credits for invoice.paid using the mapped tier", async () => {
    const store = new InMemoryBillingStore();
    const event = verify({
      id: "evt_invoice_1",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_1",
          object: "invoice",
          customer: "cus_1",
          parent: {
            type: "subscription_details",
            subscription_details: { metadata: { workspaceId: "ws_9" } },
          },
          lines: {
            data: [
              {
                id: "il_1",
                pricing: { type: "price_details", price_details: { price: "price_growth_monthly" } },
              },
            ],
          },
        },
      },
    });

    const result = await processStripeEvent(event, table, store);
    expect(result).toMatchObject({ handled: true, action: "cycle_credits_granted", duplicate: false });
    expect(store.grants[0].grant).toMatchObject({
      workspaceId: "ws_9",
      credits: tierByKey("growth").creditsPerMonth,
      reason: "grant",
    });

    await processStripeEvent(event, table, store);
    expect(store.grants).toHaveLength(1);
  });

  it("syncs subscription updates and marks deletions canceled", async () => {
    const store = new InMemoryBillingStore();
    const base = {
      id: "sub_1",
      object: "subscription",
      customer: "cus_1",
      status: "active",
      metadata: { workspaceId: "ws_2" },
      items: {
        data: [
          {
            id: "si_1",
            current_period_end: 1_790_000_000,
            price: { id: "price_starter_monthly" },
          },
        ],
      },
    };

    await processStripeEvent(
      verify({ id: "evt_sub_1", type: "customer.subscription.updated", data: { object: base } }),
      table,
      store,
    );
    expect(store.subscriptions.get("sub_1")).toMatchObject({
      workspaceId: "ws_2",
      tier: "starter",
      status: "active",
    });
    expect(store.subscriptions.get("sub_1")?.periodEnd).toBe(new Date(1_790_000_000 * 1000).toISOString());

    await processStripeEvent(
      verify({ id: "evt_sub_2", type: "customer.subscription.deleted", data: { object: base } }),
      table,
      store,
    );
    expect(store.subscriptions.get("sub_1")?.status).toBe("canceled");
  });

  it("ignores event types it does not handle", async () => {
    const store = new InMemoryBillingStore();
    const result = await processStripeEvent(
      verify({ id: "evt_x", type: "payment_intent.created", data: { object: {} } }),
      table,
      store,
    );
    expect(result).toEqual({ handled: false, action: "ignored" });
    expect(store.grants).toHaveLength(0);
  });
});
