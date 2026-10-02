/**
 * Stripe's funnel steps (docs/phases/PHASE_18.md P18-02): checkout_completed
 * once per Checkout Session, payment (and first_payment once per workspace)
 * only when a delivery applied a paid grant, booked to the grant's
 * workspace.
 */

import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { events, workspaces } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import type { Db } from "@curvi/db";
import { recordStripeFunnel, stripeFunnelSteps } from "./funnel";
import { buildPriceTable, tierPriceEnvName, topUpPriceEnvName } from "./price-table";

const ENV: Record<string, string> = {
  [tierPriceEnvName("starter", "monthly")]: "price_starter_monthly",
  [topUpPriceEnvName(100)]: "price_topup_100",
};
const table = buildPriceTable((name) => ENV[name]);

function event(type: string, object: Record<string, unknown>, id = `evt_${type}`): Stripe.Event {
  return { id, type, data: { object } } as unknown as Stripe.Event;
}

function subscriptionCheckout(workspaceId: string, sessionId = "cs_sub_1"): Stripe.Event {
  return event("checkout.session.completed", {
    id: sessionId,
    object: "checkout.session",
    mode: "subscription",
    amount_total: 1900,
    currency: "usd",
    payment_status: "paid",
    client_reference_id: workspaceId,
    metadata: { workspaceId, kind: "tier", plan: "starter", cadence: "monthly", source: "pricing" },
    total_details: { amount_discount: 1000 },
    discounts: [{ coupon: "co_1", promotion_code: "promo_founding" }],
  });
}

function topUpCheckout(workspaceId: string, sessionId = "cs_topup_1"): Stripe.Event {
  return event("checkout.session.completed", {
    id: sessionId,
    object: "checkout.session",
    mode: "payment",
    amount_total: 1500,
    currency: "usd",
    payment_status: "paid",
    metadata: { workspaceId, kind: "topup", plan: "topup", cadence: "one_time", source: "billing", priceId: "price_topup_100" },
  });
}

function paidInvoice(id: string, workspaceId: string | null, amountPaid = 2900): Stripe.Event {
  return event("invoice.paid", {
    id,
    object: "invoice",
    customer: "cus_1",
    billing_reason: "subscription_create",
    amount_paid: amountPaid,
    currency: "usd",
    parent: { type: "subscription_details", subscription_details: { metadata: workspaceId ? { workspaceId } : {} } },
    lines: {
      data: [
        {
          id: "il_1",
          amount: amountPaid,
          period: { start: 1_790_000_000, end: 1_792_592_000 },
          pricing: { type: "price_details", price_details: { price: "price_starter_monthly" } },
          parent: { type: "subscription_item_details", subscription_item_details: { proration: false } },
        },
      ],
    },
  });
}

describe("stripeFunnelSteps", () => {
  it("turns a subscription checkout into checkout_completed with its offer details", () => {
    const steps = stripeFunnelSteps(subscriptionCheckout("ws_1"), { handled: true, action: "checkout_noted" }, table);
    expect(steps).toEqual([
      {
        name: "checkout_completed",
        workspaceHint: "ws_1",
        grantKey: null,
        props: {
          checkout_session: "cs_sub_1",
          kind: "tier",
          plan: "starter",
          cadence: "monthly",
          checkout_source: "pricing",
          amount_usd: 19,
          currency: "usd",
          discounted: true,
          promotion_code: "promo_founding",
        },
      },
    ]);
  });

  it("adds a payment only when a paid top up grant was applied", () => {
    const granted = stripeFunnelSteps(topUpCheckout("ws_1"), { handled: true, action: "topup_granted", credits: 100 }, table);
    expect(granted.map((step) => step.name)).toEqual(["checkout_completed", "payment"]);
    expect(granted[1]).toMatchObject({ grantKey: "checkout:cs_topup_1", props: { kind: "topup", amount_usd: 15, credits: 100 } });
    const duplicate = stripeFunnelSteps(
      topUpCheckout("ws_1"),
      { handled: true, action: "topup_granted", duplicate: true, credits: 100 },
      table,
    );
    expect(duplicate.map((step) => step.name)).toEqual(["checkout_completed"]);
  });

  it("counts a subscription invoice that granted credits and moved money", () => {
    const steps = stripeFunnelSteps(paidInvoice("in_1", "ws_2"), { handled: true, action: "cycle_credits_granted", credits: 300 }, table);
    expect(steps).toEqual([
      {
        name: "payment",
        workspaceHint: "ws_2",
        grantKey: "invoice:in_1",
        props: {
          kind: "subscription",
          plan: "starter",
          cadence: "monthly",
          billing_reason: "subscription_create",
          amount_usd: 29,
          currency: "usd",
          credits: 300,
        },
      },
    ]);
    expect(stripeFunnelSteps(paidInvoice("in_2", "ws_2", 0), { handled: true, action: "cycle_credits_granted" }, table)).toEqual([]);
    expect(
      stripeFunnelSteps(paidInvoice("in_1", "ws_2"), { handled: true, action: "cycle_credits_granted", duplicate: true }, table),
    ).toEqual([]);
    expect(stripeFunnelSteps(event("charge.refunded", { id: "ch_1" }), { handled: true, action: "refund_clawed_back" }, table)).toEqual([]);
  });
});

describe("recordStripeFunnel", () => {
  let client: Awaited<ReturnType<typeof createTestDb>>["client"];
  let db: TestDb;
  let wsA: string;
  let wsB: string;

  beforeAll(async () => {
    const created = await createTestDb();
    client = created.client;
    db = created.db;
    const [a] = await db.insert(workspaces).values({ name: "A" }).returning();
    const [b] = await db.insert(workspaces).values({ name: "B" }).returning();
    wsA = a.id;
    wsB = b.id;
  });

  afterAll(async () => {
    await client.close();
  });

  async function funnelRows() {
    return (await db.select().from(events)).filter((row) => row.name.startsWith("funnel."));
  }

  it("records checkout_completed once per session across deliveries", async () => {
    const sub = subscriptionCheckout(wsA);
    expect(await recordStripeFunnel(db as unknown as Db, sub, { handled: true, action: "checkout_noted" }, table)).toBe(1);
    expect(await recordStripeFunnel(db as unknown as Db, sub, { handled: true, action: "checkout_noted" }, table)).toBe(0);
    const rows = (await funnelRows()).filter((row) => row.name === "funnel.checkout_completed");
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceId).toBe(wsA);
  });

  it("books a payment to the grant's workspace and writes the first payment once", async () => {
    // The billing store's claim row resolved the customer to workspace B,
    // although the invoice metadata names no workspace.
    await db.insert(events).values({ workspaceId: wsB, name: "billing:stripe:invoice:in_10", props: {} });
    await db.insert(events).values({ workspaceId: wsB, name: "billing:stripe:invoice:in_11", props: {} });
    const result = { handled: true, action: "cycle_credits_granted", credits: 300 };
    expect(await recordStripeFunnel(db as unknown as Db, paidInvoice("in_10", null), result, table)).toBe(1);
    expect(await recordStripeFunnel(db as unknown as Db, paidInvoice("in_11", null), result, table)).toBe(1);
    const rows = (await funnelRows()).filter((row) => row.workspaceId === wsB);
    expect(rows.map((row) => row.name).sort()).toEqual(["funnel.first_payment", "funnel.payment", "funnel.payment"]);
  });

  it("never throws", async () => {
    const broken = { execute: () => Promise.reject(new Error("db down")), insert: () => ({ values: () => Promise.reject(new Error("db down")) }) };
    const log = { error: vi.fn() };
    const written = await recordStripeFunnel(
      broken as unknown as Db,
      paidInvoice("in_12", "ws"),
      { handled: true, action: "cycle_credits_granted" },
      table,
      log,
    );
    expect(written).toBe(0);
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
