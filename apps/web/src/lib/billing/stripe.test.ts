import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import {
  createStripeBillingActions,
  createStripeLookup,
  duplicateRefundKey,
  isStripeMissingResource,
  STRIPE_LOOKUP_OPTIONS,
  STRIPE_LOOKUP_TIMEOUT_MS,
} from "./stripe";

/** A real SDK client whose every request fails at the network, counting
 * the attempts it makes. */
function unreachableStripe(): { stripe: Stripe; attempts: () => number } {
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const stripe = new Stripe("sk_test_placeholder", { httpClient: Stripe.createFetchHttpClient(fetchFn) });
  return { stripe, attempts: () => calls };
}

function fakeStripe(retrieve: (...args: unknown[]) => Promise<unknown>) {
  const list = vi.fn(async (..._args: unknown[]) => ({ data: [{ invoice: "in_paid" }] }));
  const retrieveMock = vi.fn(retrieve);
  const stripe = {
    subscriptions: { retrieve: retrieveMock },
    invoicePayments: { list },
  } as unknown as Stripe;
  return { stripe, list, retrieve: retrieveMock };
}

describe("createStripeLookup", () => {
  it("reads the subscription as Stripe holds it now, once, with a bounded timeout", async () => {
    const subscription = { id: "sub_1", status: "active" };
    const { stripe, retrieve } = fakeStripe(async () => subscription);
    const lookup = createStripeLookup(stripe);
    await expect(lookup.retrieveSubscription?.("sub_1")).resolves.toBe(subscription);
    expect(retrieve).toHaveBeenCalledWith("sub_1", {}, { timeout: STRIPE_LOOKUP_TIMEOUT_MS, maxNetworkRetries: 0 });
  });

  it("answers null when Stripe does not know the subscription", async () => {
    const missing = Object.assign(new Error("No such subscription"), { statusCode: 404, code: "resource_missing" });
    const { stripe } = fakeStripe(async () => {
      throw missing;
    });
    await expect(createStripeLookup(stripe).retrieveSubscription?.("sub_gone")).resolves.toBeNull();
  });

  it("throws any other failure so the webhook answers 500 and Stripe retries", async () => {
    const outage = Object.assign(new Error("api_error"), { statusCode: 500 });
    const { stripe } = fakeStripe(async () => {
      throw outage;
    });
    await expect(createStripeLookup(stripe).retrieveSubscription?.("sub_1")).rejects.toBe(outage);
  });

  it("finds the invoice a payment intent paid, once, with a bounded timeout", async () => {
    const { stripe, list } = fakeStripe(async () => null);
    await expect(createStripeLookup(stripe).invoiceIdForPaymentIntent("pi_1")).resolves.toBe("in_paid");
    expect(list).toHaveBeenCalledWith(
      { payment: { type: "payment_intent", payment_intent: "pi_1" }, limit: 1 },
      { timeout: STRIPE_LOOKUP_TIMEOUT_MS, maxNetworkRetries: 0 },
    );
  });

  it("never retries inside the request, leaving retries to Stripe's webhook redelivery", async () => {
    expect(STRIPE_LOOKUP_OPTIONS).toEqual({ timeout: STRIPE_LOOKUP_TIMEOUT_MS, maxNetworkRetries: 0 });
    // The SDK retries network failures twice by default; with these options
    // it makes one attempt and throws, so the delivery fails fast.
    const subscriptionRead = unreachableStripe();
    await expect(createStripeLookup(subscriptionRead.stripe).retrieveSubscription?.("sub_1")).rejects.toThrow();
    expect(subscriptionRead.attempts()).toBe(1);

    const invoiceRead = unreachableStripe();
    await expect(createStripeLookup(invoiceRead.stripe).invoiceIdForPaymentIntent("pi_1")).rejects.toThrow();
    expect(invoiceRead.attempts()).toBe(1);
  });

  it("recognizes only a missing resource as missing", () => {
    expect(isStripeMissingResource({ statusCode: 404 })).toBe(true);
    expect(isStripeMissingResource({ code: "resource_missing" })).toBe(true);
    expect(isStripeMissingResource({ statusCode: 429 })).toBe(false);
    expect(isStripeMissingResource(null)).toBe(false);
    expect(isStripeMissingResource("resource_missing")).toBe(false);
  });
});

describe("createStripeBillingActions", () => {
  function actionsStripe() {
    const subscriptionsList = vi.fn(async (..._args: unknown[]) => ({
      data: [{ id: "sub_1", status: "active", created: 100, customer: "cus_1", latest_invoice: { id: "in_1" } }],
    }));
    const invoicePaymentsList = vi.fn(async (..._args: unknown[]) => ({
      data: [
        { currency: "usd", amount_paid: 7900, payment: { type: "payment_intent", payment_intent: "pi_1" } },
        { currency: "usd", amount_paid: 100, payment: { type: "charge", charge: { id: "ch_2" } } },
      ],
    }));
    const refundsCreate = vi.fn(async (params: { payment_intent?: string; charge?: string }, ..._rest: unknown[]) => ({
      id: `re_${params.payment_intent ?? params.charge}`,
      amount: params.payment_intent ? 7900 : 100,
    }));
    const cancel = vi.fn(async (..._args: unknown[]) => ({ id: "sub_1", status: "canceled" }));
    const stripe = {
      subscriptions: { list: subscriptionsList, cancel },
      invoicePayments: { list: invoicePaymentsList },
      refunds: { create: refundsCreate },
    } as unknown as Stripe;
    return { stripe, subscriptionsList, invoicePaymentsList, refundsCreate, cancel };
  }

  it("lists every subscription of the customer, whatever its status", async () => {
    const { stripe, subscriptionsList } = actionsStripe();
    await expect(createStripeBillingActions(stripe).listCustomerSubscriptions("cus_1")).resolves.toEqual([
      { id: "sub_1", status: "active", created: 100, customerId: "cus_1", latestInvoiceId: "in_1" },
    ]);
    expect(subscriptionsList).toHaveBeenCalledWith({ customer: "cus_1", status: "all", limit: 20 }, STRIPE_LOOKUP_OPTIONS);
  });

  it("refunds each paid payment of the invoice in full with a key per subscription", async () => {
    const { stripe, invoicePaymentsList, refundsCreate } = actionsStripe();
    const refund = await createStripeBillingActions(stripe).refundInvoice("sub_dup", "in_dup");
    expect(refund).toEqual({ amount: 8000, currency: "usd", refundIds: ["re_pi_1", "re_ch_2"] });
    expect(invoicePaymentsList).toHaveBeenCalledWith({ invoice: "in_dup", status: "paid", limit: 10 }, STRIPE_LOOKUP_OPTIONS);
    const [first, second] = refundsCreate.mock.calls;
    expect(first?.[0]).toMatchObject({ payment_intent: "pi_1", reason: "duplicate" });
    expect(first?.[0]).not.toHaveProperty("amount");
    expect(first?.[1]).toMatchObject({ idempotencyKey: "curvi-dup-refund-sub_dup", timeout: STRIPE_LOOKUP_TIMEOUT_MS });
    expect(second?.[0]).toMatchObject({ charge: "ch_2" });
    expect(second?.[1]).toMatchObject({ idempotencyKey: "curvi-dup-refund-sub_dup-1" });
    expect(duplicateRefundKey("sub_dup")).toBe("curvi-dup-refund-sub_dup");
  });

  it("counts a payment already refunded instead of failing the delivery", async () => {
    const { stripe, refundsCreate } = actionsStripe();
    refundsCreate.mockRejectedValueOnce(Object.assign(new Error("already refunded"), { code: "charge_already_refunded" }));
    const refund = await createStripeBillingActions(stripe).refundInvoice("sub_dup", "in_dup");
    expect(refund.amount).toBe(8000);
    expect(refund.refundIds).toEqual(["re_ch_2"]);

    refundsCreate.mockRejectedValueOnce(new Error("Stripe is down"));
    await expect(createStripeBillingActions(stripe).refundInvoice("sub_dup", "in_dup")).rejects.toThrow("Stripe is down");
  });

  it("cancels at once with no final invoice and no proration", async () => {
    const { stripe, cancel } = actionsStripe();
    await createStripeBillingActions(stripe).cancelSubscription("sub_dup");
    expect(cancel).toHaveBeenCalledWith("sub_dup", { invoice_now: false, prorate: false }, STRIPE_LOOKUP_OPTIONS);
  });
});
