import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/webhooks/stripe (P18-24): a referral step that failed answers
// 500, so Stripe delivers the event again and the reward or its clawback
// is not lost. Billing and the referral steps are idempotent, so the retry
// is safe. A delivery whose referral steps went through answers 200.

const state = vi.hoisted(() => ({ failed: false }));

vi.mock("@/lib/services", () => ({ isDbMode: () => true }));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/billing/db-store", () => ({ DbBillingStore: class {} }));
vi.mock("@/lib/billing/funnel", () => ({ recordStripeFunnel: async () => undefined }));
vi.mock("@/lib/billing/stripe-webhook", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/stripe-webhook")>();
  return {
    ...actual,
    verifyStripeEvent: () => ({ id: "evt_1", type: "checkout.session.completed", data: { object: {} } }),
    processStripeEvent: async () => ({ handled: true, action: "topup_granted" }),
  };
});
vi.mock("@/lib/referrals/stripe", () => ({
  recordStripeReferrals: async () => ({ steps: [], failed: state.failed }),
}));

const { POST } = await import("./route");

function delivery(): Request {
  return new Request("https://curvi.ai/api/webhooks/stripe", {
    method: "POST",
    body: "{}",
    headers: { "stripe-signature": "t=1,v1=abc" },
  });
}

beforeEach(() => {
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test");
  vi.stubEnv("STRIPE_SECRET_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  state.failed = false;
});

describe("POST /api/webhooks/stripe referral steps", () => {
  it("answers 200 when the referral steps went through", async () => {
    const response = await POST(delivery());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: true, action: "topup_granted" });
  });

  it("answers 500 when a referral step failed, so Stripe delivers again", async () => {
    state.failed = true;
    const response = await POST(delivery());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "referral_failed", eventId: "evt_1" });
  });
});
