import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { createStripeLookup, isStripeMissingResource, STRIPE_LOOKUP_OPTIONS, STRIPE_LOOKUP_TIMEOUT_MS } from "./stripe";

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
