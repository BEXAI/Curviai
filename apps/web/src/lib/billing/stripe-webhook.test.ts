import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { tierByKey, topUps } from "@curvi/pipeline/seed";
import { buildPriceTable, tierPriceEnvName, topUpPriceEnvName } from "./price-table";
import {
  HANDLED_STRIPE_EVENTS,
  InMemoryBillingStore,
  planInvoiceGrant,
  processStripeEvent,
  UnroutableBillingEventError,
  verifyStripeEvent,
} from "./stripe-webhook";

const SECRET = "whsec_test_secret";
const stripe = new Stripe("sk_test_placeholder");

const ENV: Record<string, string> = {
  [tierPriceEnvName("starter", "monthly")]: "price_starter_monthly",
  [tierPriceEnvName("growth", "monthly")]: "price_growth_monthly",
  [tierPriceEnvName("growth", "annual")]: "price_growth_annual",
  [tierPriceEnvName("pro", "monthly")]: "price_pro_monthly",
  [tierPriceEnvName("pro", "annual")]: "price_pro_annual",
  [topUpPriceEnvName(100)]: "price_topup_100",
};

const table = buildPriceTable((name) => ENV[name]);

const growth = tierByKey("growth");
const pro = tierByKey("pro");
const DAY = 24 * 60 * 60;
const T0 = 1_790_000_000;

function signedEvent(payloadObject: Record<string, unknown>): { payload: string; header: string } {
  const payload = JSON.stringify(payloadObject);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return { payload, header };
}

function verify(payloadObject: Record<string, unknown>): Stripe.Event {
  const { payload, header } = signedEvent(payloadObject);
  return verifyStripeEvent(payload, header, SECRET);
}

interface LineFixture {
  price: string;
  amount: number;
  proration?: boolean;
  start?: number;
  end?: number;
}

function line({ price, amount, proration = false, start = T0, end = T0 + 30 * DAY }: LineFixture) {
  return {
    id: `il_${price}_${amount}`,
    amount,
    period: { start, end },
    pricing: { type: "price_details", price_details: { price } },
    parent: {
      type: "subscription_item_details",
      subscription_item_details: { proration, subscription: "sub_1", subscription_item: "si_1" },
      invoice_item_details: null,
    },
  };
}

function invoiceEvent(
  id: string,
  billingReason: string | null,
  lines: ReturnType<typeof line>[],
  workspaceId: string | null = "ws_9",
  customer = "cus_1",
): Stripe.Event {
  return verify({
    id: `evt_${id}`,
    type: "invoice.paid",
    data: {
      object: {
        id,
        object: "invoice",
        customer,
        billing_reason: billingReason,
        parent: {
          type: "subscription_details",
          subscription_details: { metadata: workspaceId ? { workspaceId } : {} },
        },
        lines: { data: lines },
      },
    },
  });
}

function checkoutEvent(
  eventId: string,
  type: string,
  overrides: Record<string, unknown> = {},
): Stripe.Event {
  return verify({
    id: eventId,
    type,
    data: {
      object: {
        id: "cs_1",
        object: "checkout.session",
        mode: "payment",
        customer: "cus_1",
        payment_status: "paid",
        payment_intent: "pi_topup_1",
        metadata: { workspaceId: "ws_1", priceId: "price_topup_100" },
        ...overrides,
      },
    },
  });
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
    expect(table["price_growth_annual"]).toMatchObject({ kind: "tier", tier: "growth", cadence: "annual" });
    expect(table["price_topup_100"]).toEqual({
      kind: "topup",
      credits: 100,
      expiresMonths: topUps.find((t) => t.credits === 100)?.expiresMonths,
    });
    expect(table["price_unset"]).toBeUndefined();
  });
});

describe("top ups (Update.md 1.4)", () => {
  it("grants a paid top up once and dedupes the retry", async () => {
    const store = new InMemoryBillingStore();
    const event = checkoutEvent("evt_checkout_1", "checkout.session.completed");

    const first = await processStripeEvent(event, table, store);
    expect(first).toMatchObject({ handled: true, action: "topup_granted", duplicate: false, credits: 100 });
    const second = await processStripeEvent(event, table, store);
    expect(second).toMatchObject({ handled: true, action: "topup_granted", duplicate: true });

    expect(store.grants).toHaveLength(1);
    expect(store.grants[0].grant).toMatchObject({
      workspaceId: "ws_1",
      credits: 100,
      reason: "topup",
      payment: { paymentIntentId: "pi_topup_1", checkoutSessionId: "cs_1" },
    });
    expect(store.customerLinks.get("ws_1")).toBe("cus_1");
  });

  it("does not grant when the session completes before the payment clears", async () => {
    const store = new InMemoryBillingStore();
    const result = await processStripeEvent(
      checkoutEvent("evt_checkout_unpaid", "checkout.session.completed", { payment_status: "unpaid" }),
      table,
      store,
    );
    expect(result).toEqual({ handled: true, action: "topup_awaiting_payment" });
    expect(store.grants).toHaveLength(0);
  });

  it("grants once on async_payment_succeeded, even if delivered twice", async () => {
    const store = new InMemoryBillingStore();
    await processStripeEvent(
      checkoutEvent("evt_checkout_unpaid", "checkout.session.completed", { payment_status: "unpaid" }),
      table,
      store,
    );
    const success = checkoutEvent("evt_async_ok", "checkout.session.async_payment_succeeded");
    expect(await processStripeEvent(success, table, store)).toMatchObject({ action: "topup_granted", duplicate: false });
    expect(await processStripeEvent(success, table, store)).toMatchObject({ action: "topup_granted", duplicate: true });
    expect(store.grants).toHaveLength(1);
  });

  it("records an async payment failure without granting", async () => {
    const store = new InMemoryBillingStore();
    const result = await processStripeEvent(
      checkoutEvent("evt_async_fail", "checkout.session.async_payment_failed", { payment_status: "unpaid" }),
      table,
      store,
    );
    expect(result).toEqual({ handled: true, action: "topup_payment_failed" });
    expect(store.grants).toHaveLength(0);
    expect(store.notes[0].note.kind).toBe("async_payment_failed");
  });
});

describe("subscription invoices (Update.md 1.2, money-webhook-hardening)", () => {
  it("grants one month on a monthly cycle invoice, keyed on the invoice", async () => {
    const store = new InMemoryBillingStore();
    const event = invoiceEvent("in_1", "subscription_cycle", [line({ price: "price_growth_monthly", amount: 7900 })]);

    const result = await processStripeEvent(event, table, store);
    expect(result).toMatchObject({ handled: true, action: "cycle_credits_granted", duplicate: false });
    expect(store.grants[0].grant).toMatchObject({
      workspaceId: "ws_9",
      credits: growth.creditsPerMonth,
      reason: "grant",
      payment: { invoiceId: "in_1" },
    });

    await processStripeEvent(event, table, store);
    expect(store.grants).toHaveLength(1);
  });

  it("grants the full year up front on a paid annual invoice", async () => {
    const store = new InMemoryBillingStore();
    const event = invoiceEvent("in_annual", "subscription_create", [
      line({ price: "price_growth_annual", amount: 79200, end: T0 + 365 * DAY }),
    ]);
    const result = await processStripeEvent(event, table, store);
    expect(result).toMatchObject({ action: "cycle_credits_granted", credits: growth.creditsPerMonth * 12 });
    expect(store.grants[0].grant.credits).toBe(growth.creditsPerMonth * 12);
  });

  it("grants only the upgrade difference on a plan change invoice", async () => {
    const plan = planInvoiceGrant(
      invoiceEvent("in_up", "subscription_update", [
        line({ price: "price_growth_monthly", amount: -3900, proration: true }),
        line({ price: "price_pro_monthly", amount: 7400, proration: true }),
      ]).data.object as Stripe.Invoice,
      table,
    );
    expect(plan.credits).toBe(pro.creditsPerMonth - growth.creditsPerMonth);
    expect(plan.base).toBe(0);
  });

  it("does not use the first line when a cycle invoice starts with a proration", async () => {
    const store = new InMemoryBillingStore();
    const event = invoiceEvent("in_cycle_mixed", "subscription_cycle", [
      line({ price: "price_growth_monthly", amount: -3900, proration: true }),
      line({ price: "price_pro_monthly", amount: 7400, proration: true }),
      line({ price: "price_pro_monthly", amount: 14900 }),
    ]);
    await processStripeEvent(event, table, store);
    expect(store.grants[0].grant.credits).toBe(pro.creditsPerMonth + (pro.creditsPerMonth - growth.creditsPerMonth));
  });

  it("takes back the credit difference on a downgrade, since Stripe returns the unused money", async () => {
    const store = new InMemoryBillingStore();
    await processStripeEvent(
      invoiceEvent("in_pro_cycle", "subscription_cycle", [line({ price: "price_pro_monthly", amount: 14900 })]),
      table,
      store,
    );
    const downgrade = invoiceEvent("in_down", "subscription_update", [
      line({ price: "price_pro_monthly", amount: -7400, proration: true }),
      line({ price: "price_growth_monthly", amount: 3900, proration: true }),
    ]);
    const result = await processStripeEvent(downgrade, table, store);
    expect(result).toEqual({
      handled: true,
      action: "plan_change_credits_returned",
      credits: pro.creditsPerMonth - growth.creditsPerMonth,
    });
    expect(store.balance("ws_9")).toBe(growth.creditsPerMonth);
    expect(await processStripeEvent(downgrade, table, store)).toMatchObject({ duplicate: true });
    expect(store.balance("ws_9")).toBe(growth.creditsPerMonth);
  });

  it("never takes a downgrade below a zero balance", async () => {
    const store = new InMemoryBillingStore();
    const result = await processStripeEvent(
      invoiceEvent("in_down_empty", "subscription_update", [
        line({ price: "price_pro_monthly", amount: -7400, proration: true }),
        line({ price: "price_growth_monthly", amount: 3900, proration: true }),
      ]),
      table,
      store,
    );
    expect(result).toMatchObject({ action: "plan_change_credits_returned", credits: 0 });
    expect(store.balance("ws_9")).toBe(0);
  });

  it("switching monthly to annual grants the year minus the month already granted", async () => {
    const plan = planInvoiceGrant(
      invoiceEvent("in_interval", "subscription_update", [
        line({ price: "price_growth_monthly", amount: -3900, proration: true }),
        line({ price: "price_growth_annual", amount: 79200, end: T0 + 365 * DAY }),
      ]).data.object as Stripe.Invoice,
      table,
    );
    expect(plan.credits).toBe(growth.creditsPerMonth * 12 - growth.creditsPerMonth);
  });

  it("prorates an annual upgrade by the months left", async () => {
    const half = { start: T0, end: T0 + 182 * DAY };
    const plan = planInvoiceGrant(
      invoiceEvent("in_annual_up", "subscription_update", [
        line({ price: "price_growth_annual", amount: -39600, proration: true, ...half }),
        line({ price: "price_pro_annual", amount: 74400, proration: true, ...half }),
      ]).data.object as Stripe.Invoice,
      table,
    );
    expect(plan.credits).toBe((pro.creditsPerMonth - growth.creditsPerMonth) * 6);
  });

  it("ignores manual invoices and unknown prices", async () => {
    const store = new InMemoryBillingStore();
    await processStripeEvent(
      invoiceEvent("in_manual", "manual", [line({ price: "price_growth_monthly", amount: 7900 })]),
      table,
      store,
    );
    await processStripeEvent(
      invoiceEvent("in_unknown", "subscription_cycle", [line({ price: "price_other", amount: 7900 })]),
      table,
      store,
    );
    expect(store.grants).toHaveLength(0);
  });

  it("throws a retryable error for a grant no workspace can receive", async () => {
    const store = new InMemoryBillingStore({ requireRouting: true });
    const event = invoiceEvent("in_orphan", "subscription_cycle", [line({ price: "price_growth_monthly", amount: 7900 })], null, "cus_unknown");
    await expect(processStripeEvent(event, table, store)).rejects.toBeInstanceOf(UnroutableBillingEventError);
    expect(store.grants).toHaveLength(0);

    await store.linkCustomer("ws_linked", "cus_unknown");
    await processStripeEvent(event, table, store);
    expect(store.grants).toHaveLength(1);
  });

  it("notes failed payments and 3D Secure requests", async () => {
    const store = new InMemoryBillingStore();
    const failed = verify({
      id: "evt_fail",
      type: "invoice.payment_failed",
      data: { object: { id: "in_f", object: "invoice", customer: "cus_1", attempt_count: 2, metadata: { workspaceId: "ws_9" } } },
    });
    expect(await processStripeEvent(failed, table, store)).toEqual({ handled: true, action: "payment_failure_noted" });
    const action = verify({
      id: "evt_action",
      type: "invoice.payment_action_required",
      data: { object: { id: "in_a", object: "invoice", customer: "cus_1" } },
    });
    expect(await processStripeEvent(action, table, store)).toEqual({ handled: true, action: "payment_action_noted" });
    expect(store.notes.map((n) => n.note.kind)).toEqual(["payment_failed", "payment_action_required"]);
    expect(store.notes[0].note.props).toMatchObject({ invoiceId: "in_f", attemptCount: 2 });
  });
});

describe("subscription sync (Update.md 1.1)", () => {
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

  it("syncs created and updated subscriptions and marks deletions canceled", async () => {
    const store = new InMemoryBillingStore();
    const created = await processStripeEvent(
      verify({ id: "evt_sub_0", type: "customer.subscription.created", data: { object: base } }),
      table,
      store,
    );
    expect(created).toEqual({ handled: true, action: "subscription_synced" });
    expect(store.subscriptions.get("sub_1")).toMatchObject({ workspaceId: "ws_2", tier: "starter", status: "active" });
    expect(store.subscriptions.get("sub_1")?.periodEnd).toBe(new Date(1_790_000_000 * 1000).toISOString());

    await processStripeEvent(
      verify({ id: "evt_sub_2", type: "customer.subscription.deleted", data: { object: base } }),
      table,
      store,
    );
    expect(store.subscriptions.get("sub_1")?.status).toBe("canceled");
  });
});

describe("refunds and disputes (Phase 10 decision 3)", () => {
  async function storeWithTopUp(): Promise<InMemoryBillingStore> {
    const store = new InMemoryBillingStore();
    await processStripeEvent(checkoutEvent("evt_checkout_1", "checkout.session.completed"), table, store);
    return store;
  }

  function refundEvent(id: string, amountRefunded: number, paymentIntent = "pi_topup_1"): Stripe.Event {
    return verify({
      id,
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          object: "charge",
          amount: 1500,
          amount_refunded: amountRefunded,
          payment_intent: paymentIntent,
        },
      },
    });
  }

  it("claws back a refunded top up in proportion and only once per event", async () => {
    const store = await storeWithTopUp();
    const half = refundEvent("evt_refund_half", 750);
    expect(await processStripeEvent(half, table, store)).toMatchObject({ action: "refund_clawed_back", credits: 50 });
    expect(await processStripeEvent(half, table, store)).toMatchObject({ duplicate: true });
    expect(store.balance("ws_1")).toBe(50);

    const full = refundEvent("evt_refund_full", 1500);
    expect(await processStripeEvent(full, table, store)).toMatchObject({ credits: 50 });
    expect(store.balance("ws_1")).toBe(0);
  });

  it("finds a subscription invoice through the Stripe lookup for a dispute", async () => {
    const store = new InMemoryBillingStore();
    await processStripeEvent(
      invoiceEvent("in_disputed", "subscription_cycle", [line({ price: "price_growth_monthly", amount: 7900 })]),
      table,
      store,
    );
    const dispute = verify({
      id: "evt_dispute",
      type: "charge.dispute.created",
      data: { object: { id: "dp_1", object: "dispute", charge: "ch_9", payment_intent: "pi_invoice_9", amount: 7900 } },
    });
    const lookup = {
      invoiceIdForPaymentIntent: async (pi: string) => (pi === "pi_invoice_9" ? "in_disputed" : null),
    };
    const result = await processStripeEvent(dispute, table, store, { lookup });
    expect(result).toMatchObject({ action: "dispute_clawed_back", credits: growth.creditsPerMonth });
    expect(store.balance("ws_9")).toBe(0);
  });

  it("reports a refund with no matching grant", async () => {
    const store = new InMemoryBillingStore();
    const result = await processStripeEvent(refundEvent("evt_refund_x", 1500, "pi_unknown"), table, store);
    expect(result).toEqual({ handled: true, action: "refund_no_grant" });
  });
});

describe("handled events", () => {
  it("acts on every event type the setup doc subscribes to", async () => {
    for (const type of HANDLED_STRIPE_EVENTS) {
      const store = new InMemoryBillingStore();
      const result = await processStripeEvent(
        verify({
          id: `evt_${type}`,
          type,
          data: { object: { id: `obj_${type}`, amount: 100, amount_refunded: 100, items: { data: [] } } },
        }),
        table,
        store,
      );
      expect(result.handled, type).toBe(true);
    }
  });
});

describe("unhandled events", () => {
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
