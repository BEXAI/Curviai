import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/webhooks/stripe answers 500 on any processing error, so Stripe
// retries; every handler is idempotent, so the retry cannot double grant.

const SECRET = "whsec_route_test";
const behavior: { mode: "ok" | "unroutable" | "crash"; deps: unknown } = { mode: "ok", deps: null };

vi.mock("@/lib/services", () => ({ isDbMode: () => false }));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({}) }));

vi.mock("@/lib/billing/stripe-webhook", async (importOriginal) => {
  const original = await importOriginal<typeof import("./stripe-webhook")>();
  return {
    ...original,
    processStripeEvent: async (...args: Parameters<typeof original.processStripeEvent>) => {
      behavior.deps = args[3];
      if (behavior.mode === "unroutable") {
        throw new original.UnroutableBillingEventError("No workspace for billing grant invoice:in_1");
      }
      if (behavior.mode === "crash") {
        throw new Error("database unavailable");
      }
      return original.processStripeEvent(...args);
    },
  };
});

const { POST } = await import("@/app/api/webhooks/stripe/route");

function signedRequest(payload: Record<string, unknown>): Request {
  const body = JSON.stringify(payload);
  const header = new Stripe("sk_test_placeholder").webhooks.generateTestHeaderString({ payload: body, secret: SECRET });
  return new Request("https://curvi.ai/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": header },
    body,
  });
}

const paidEvent = { id: "evt_route", type: "payment_intent.created", data: { object: {} } };

beforeEach(() => {
  behavior.mode = "ok";
  behavior.deps = null;
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/webhooks/stripe", () => {
  it("acknowledges a verified event", async () => {
    const response = await POST(signedRequest(paidEvent));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: true, action: "ignored" });
  });

  it("rejects a bad signature with 400", async () => {
    const request = new Request("https://curvi.ai/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=bad" },
      body: JSON.stringify(paidEvent),
    });
    expect((await POST(request)).status).toBe(400);
  });

  it("answers 500 for an unroutable event so Stripe retries", async () => {
    behavior.mode = "unroutable";
    const response = await POST(signedRequest(paidEvent));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "unroutable_event", eventId: "evt_route" });
  });

  it("answers 500 when processing fails", async () => {
    behavior.mode = "crash";
    const response = await POST(signedRequest(paidEvent));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "processing_failed" });
  });

  it("gives the handler a Stripe lookup that reads subscriptions once Stripe has keys", async () => {
    await POST(signedRequest(paidEvent));
    expect(behavior.deps).toEqual({});

    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_route");
    await POST(signedRequest(paidEvent));
    const lookup = (behavior.deps as { lookup?: Record<string, unknown> }).lookup;
    expect(typeof lookup?.invoiceIdForPaymentIntent).toBe("function");
    expect(typeof lookup?.retrieveSubscription).toBe("function");
  });
});
