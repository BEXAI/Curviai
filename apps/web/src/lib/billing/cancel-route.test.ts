import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRole } from "@/lib/services/types";
import { cancelStateFromRows } from "./cancel-store";

// Route level tests for /api/billing/cancel in demo mode (no Stripe keys,
// no database): the flow shows the offers and accepts a choice without
// calling Stripe, and the role and input checks hold.

const state: { role: WorkspaceRole; signedIn: boolean; plan: string } = {
  role: "owner",
  signedIn: true,
  plan: "growth",
};

vi.mock("@/lib/services", () => ({
  isDbMode: () => false,
  getServices: () => ({
    ensureWorkspace: async () =>
      state.signedIn ? { id: "ws_1", name: "Test", plan: state.plan, creditBalance: 15, role: state.role } : null,
  }),
}));

vi.mock("@/lib/services/db", () => ({ getDb: () => ({}) }));

vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => ({ id: "user_1", email: "owner@example.com" }),
}));

const stripeCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/billing/stripe", async (importOriginal) => {
  const original = await importOriginal<typeof import("./stripe")>();
  return {
    ...original,
    getStripe: () => {
      stripeCalls.count += 1;
      throw new Error("Stripe must not be called without keys");
    },
  };
});

const { GET, POST } = await import("@/app/api/billing/cancel/route");

function post(body: unknown): Request {
  return new Request("http://localhost/api/billing/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  state.role = "owner";
  state.signedIn = true;
  state.plan = "growth";
  stripeCalls.count = 0;
  delete process.env.STRIPE_SECRET_KEY;
});

describe("GET /api/billing/cancel", () => {
  it("returns the reasons and the save offers for the plan", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tier).toBe("growth");
    expect(body.live).toBe(false);
    expect(body.reasons.length).toBeGreaterThan(3);
    expect(body.offers.map((o: { kind: string }) => o.kind)).toEqual(["pause", "downgrade", "discount"]);
    expect(stripeCalls.count).toBe(0);
  });

  it("answers 401 signed out, 403 for a client seat and 409 on Free", async () => {
    state.signedIn = false;
    expect((await GET()).status).toBe(401);
    state.signedIn = true;
    state.role = "client";
    expect((await GET()).status).toBe(403);
    state.role = "owner";
    state.plan = "free";
    const free = await GET();
    expect(free.status).toBe(409);
    expect((await free.json()).notice).toContain("Free plan");
  });
});

describe("POST /api/billing/cancel", () => {
  it("accepts a choice without Stripe and says nothing changed today", async () => {
    const response = await POST(post({ reason: "too_expensive", detail: "Too pricey", choice: "cancel" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, outcome: "canceled", stripeApplied: false });
    expect(body.notice).toContain("nothing is charged or changed today");
    expect(stripeCalls.count).toBe(0);
  });

  it("rejects bad input before touching billing", async () => {
    expect((await POST(post("not json"))).status).toBe(400);
    expect((await POST(post({ reason: "bored", choice: "cancel" }))).status).toBe(400);
    expect((await POST(post({ reason: "other", choice: "refund" }))).status).toBe(400);
    expect((await POST(post({ reason: "other", choice: "cancel", detail: "x".repeat(501) }))).status).toBe(400);
    expect((await POST(post({ reason: "other", choice: "cancel", detail: "<script>" }))).status).toBe(400);
  });

  it("keeps client seats out", async () => {
    state.role = "client";
    expect((await POST(post({ reason: "other", choice: "cancel" }))).status).toBe(403);
  });
});

describe("cancelStateFromRows", () => {
  const now = new Date("2026-09-28T00:00:00Z");
  const later = new Date("2026-10-28T00:00:00Z");
  const earlier = new Date("2026-08-28T00:00:00Z");

  it("marks taken offers as used, but not ones Stripe refused", () => {
    const state = cancelStateFromRows(
      [
        { outcome: "discounted", error: "card_declined", stripeApplied: false, effectiveAt: null },
        { outcome: "paused", error: null, stripeApplied: true, effectiveAt: earlier },
      ],
      now,
    );
    expect([...state.usedOffers]).toEqual(["pause"]);
    expect(state.pending).toBeNull();
  });

  it("reports a cancellation or pause Stripe holds that is still ahead", () => {
    expect(
      cancelStateFromRows([{ outcome: "canceled", error: null, stripeApplied: true, effectiveAt: later }], now).pending,
    ).toEqual({ outcome: "canceled", effectiveAt: later.toISOString() });
    // Recorded only (no Stripe) is not pending; keeping the plan is skipped.
    expect(
      cancelStateFromRows([{ outcome: "canceled", error: null, stripeApplied: false, effectiveAt: later }], now).pending,
    ).toBeNull();
    expect(
      cancelStateFromRows(
        [
          { outcome: "kept", error: null, stripeApplied: false, effectiveAt: null },
          { outcome: "paused", error: null, stripeApplied: true, effectiveAt: later },
        ],
        now,
      ).pending?.outcome,
    ).toBe("paused");
  });
});
