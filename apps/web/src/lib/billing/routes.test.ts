import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRole } from "@/lib/services/types";
import type { BillingAccount } from "./account";

// Route level tests for /api/billing/checkout, /api/billing/portal and
// /api/billing/upgrade-request with the service layer, the account reader
// and the Stripe client mocked, so no network or database is needed.

const state: {
  role: WorkspaceRole;
  signedIn: boolean;
  account: BillingAccount;
} = {
  role: "owner",
  signedIn: true,
  account: { stripeCustomerId: null, subscription: null },
};

const stripeMock = {
  checkout: { sessions: { create: vi.fn(async (_params: unknown) => ({ url: "https://checkout.stripe.test/session" })) } },
  billingPortal: { sessions: { create: vi.fn(async (_params: unknown) => ({ url: "https://billing.stripe.test/portal" })) } },
  subscriptions: {
    retrieve: vi.fn(async () => ({ items: { data: [{ id: "si_1", price: { id: "price_growth_monthly" } }] } })),
  },
};

vi.mock("@/lib/services", () => ({
  isDbMode: () => false,
  getServices: () => ({
    ensureWorkspace: async () =>
      state.signedIn
        ? { id: "ws_1", name: "Test", plan: "free", creditBalance: 15, role: state.role }
        : null,
  }),
}));

vi.mock("@/lib/services/db", () => ({ getDb: () => ({}) }));

vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => ({ id: "user_1", email: "owner@example.com" }),
}));

vi.mock("@/lib/billing/account", async (importOriginal) => {
  const original = await importOriginal<typeof import("./account")>();
  return {
    ...original,
    loadBillingAccount: async () => state.account,
  };
});

vi.mock("@/lib/billing/stripe", () => ({
  getStripe: () => stripeMock,
  isStripeTaxEnabled: () => false,
  createStripeLookup: () => ({ invoiceIdForPaymentIntent: async () => null }),
}));

const { POST: checkout } = await import("@/app/api/billing/checkout/route");
const { POST: portal } = await import("@/app/api/billing/portal/route");
const { POST: upgradeRequest } = await import("@/app/api/billing/upgrade-request/route");

function jsonRequest(body: unknown): Request {
  return new Request("https://curvi.ai/api/billing/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const growthAnnual = { kind: "tier", tier: "growth", cadence: "annual", source: "pricing" };

beforeEach(() => {
  state.role = "owner";
  state.signedIn = true;
  state.account = { stripeCustomerId: null, subscription: null };
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_routes");
  vi.stubEnv("STRIPE_PRICE_GROWTH_MONTHLY", "price_growth_monthly");
  vi.stubEnv("STRIPE_PRICE_GROWTH_ANNUAL", "price_growth_annual");
  vi.stubEnv("STRIPE_PRICE_TOPUP_100", "price_topup_100");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
  stripeMock.checkout.sessions.create.mockClear();
  stripeMock.billingPortal.sessions.create.mockClear();
  stripeMock.subscriptions.retrieve.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("client role cannot bill (Update.md 4.4)", () => {
  it("checkout answers 403 for a client seat and never reaches Stripe", async () => {
    state.role = "client";
    const response = await checkout(jsonRequest(growthAnnual));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "billing_forbidden" });
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("portal answers 403 for a client seat", async () => {
    state.role = "client";
    state.account = { stripeCustomerId: "cus_1", subscription: null };
    const response = await portal();
    expect(response.status).toBe(403);
    expect(stripeMock.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it("upgrade requests answer 403 for a client seat", async () => {
    state.role = "client";
    const response = await upgradeRequest(jsonRequest({ kind: "tier", tier: "growth", cadence: "monthly" }));
    expect(response.status).toBe(403);
  });

  it("editors can still start checkout", async () => {
    state.role = "editor";
    const response = await checkout(jsonRequest(growthAnnual));
    expect(response.status).toBe(200);
  });
});

describe("POST /api/billing/checkout", () => {
  it("answers 401 when signed out", async () => {
    state.signedIn = false;
    const response = await checkout(jsonRequest(growthAnnual));
    expect(response.status).toBe(401);
  });

  it("answers 503 with an honest notice while Stripe has no keys", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const response = await checkout(jsonRequest(growthAnnual));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "billing_not_configured" });
  });

  it("maps annual Growth to STRIPE_PRICE_GROWTH_ANNUAL with the signed in email", async () => {
    const response = await checkout(jsonRequest(growthAnnual));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "https://checkout.stripe.test/session", via: "checkout" });
    const params = stripeMock.checkout.sessions.create.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(params).toMatchObject({
      mode: "subscription",
      line_items: [{ price: "price_growth_annual", quantity: 1 }],
      allow_promotion_codes: true,
      metadata: { plan: "growth", cadence: "annual", source: "pricing", workspaceId: "ws_1" },
    });
  });

  it("reuses the stored Stripe customer", async () => {
    state.account = { stripeCustomerId: "cus_saved", subscription: null };
    await checkout(jsonRequest({ kind: "topup", credits: 100 }));
    const params = stripeMock.checkout.sessions.create.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(params).toMatchObject({ customer: "cus_saved", mode: "payment" });
    expect(params.customer_email).toBeUndefined();
  });

  it("sends an existing subscriber to the portal instead of a second subscription", async () => {
    state.account = {
      stripeCustomerId: "cus_saved",
      subscription: { externalId: "sub_live", tier: "starter", status: "active", periodEnd: null },
    };
    const response = await checkout(jsonRequest(growthAnnual));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "https://billing.stripe.test/portal", via: "portal" });
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    const params = stripeMock.billingPortal.sessions.create.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(params).toMatchObject({
      customer: "cus_saved",
      flow_data: {
        type: "subscription_update_confirm",
        subscription_update_confirm: { subscription: "sub_live", items: [{ id: "si_1", price: "price_growth_annual" }] },
      },
    });
  });

  it("still sells top ups to an existing subscriber", async () => {
    state.account = {
      stripeCustomerId: "cus_saved",
      subscription: { externalId: "sub_live", tier: "starter", status: "active", periodEnd: null },
    };
    const response = await checkout(jsonRequest({ kind: "topup", credits: 100 }));
    expect(await response.json()).toMatchObject({ via: "checkout" });
  });

  it("rejects unknown tiers and sources", async () => {
    expect((await checkout(jsonRequest({ kind: "tier", tier: "free", cadence: "monthly" }))).status).toBe(400);
    expect((await checkout(jsonRequest({ ...growthAnnual, source: "elsewhere" }))).status).toBe(400);
  });

  it("answers 502 when Stripe rejects the session", async () => {
    stripeMock.checkout.sessions.create.mockRejectedValueOnce(new Error("terms URL missing"));
    const response = await checkout(jsonRequest(growthAnnual));
    expect(response.status).toBe(502);
  });
});

describe("POST /api/billing/portal", () => {
  it("answers 409 before the first payment", async () => {
    const response = await portal();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "no_customer" });
  });

  it("opens the portal for the stored customer", async () => {
    state.account = { stripeCustomerId: "cus_saved", subscription: null };
    const response = await portal();
    expect(await response.json()).toEqual({ url: "https://billing.stripe.test/portal" });
    expect(stripeMock.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: "cus_saved",
      return_url: "https://curvi.ai/app/billing",
    });
  });
});

describe("POST /api/billing/upgrade-request", () => {
  it("acknowledges a plan request while card payments are not open", async () => {
    const response = await upgradeRequest(jsonRequest({ kind: "tier", tier: "growth", cadence: "annual" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it("rejects an unknown plan", async () => {
    const response = await upgradeRequest(jsonRequest({ kind: "tier", tier: "enterprise", cadence: "annual" }));
    expect(response.status).toBe(400);
  });
});
