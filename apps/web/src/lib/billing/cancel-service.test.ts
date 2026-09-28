import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { NewCancelFlow } from "@curvi/db";
import type { BillingAccount } from "./account";
import type { SaveOfferKind } from "./cancel-flow";
import { applyCancelChoice, cancelOptions, cancelTier, type CancelDeps, type CancelState } from "./cancel-service";
import type { PriceTable } from "./price-table";

const NOW = new Date("2026-09-28T12:00:00Z");
const PERIOD_END = Math.floor(new Date("2026-10-15T00:00:00Z").getTime() / 1000);

const table: PriceTable = {
  price_growth_m: { kind: "tier", tier: "growth", cadence: "monthly", creditsPerMonth: 600, priceCents: 7900 },
  price_starter_m: { kind: "tier", tier: "starter", cadence: "monthly", creditsPerMonth: 200, priceCents: 2900 },
  price_growth_a: { kind: "tier", tier: "growth", cadence: "annual", creditsPerMonth: 600, priceCents: 79200 },
};

function subscription(overrides: Partial<Stripe.Subscription> = {}, priceId = "price_growth_m"): Stripe.Subscription {
  return {
    id: "sub_1",
    status: "active",
    cancel_at_period_end: false,
    pause_collection: null,
    discounts: [],
    items: { data: [{ id: "si_1", price: { id: priceId }, current_period_end: PERIOD_END }] },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function fakeStripe(sub: Stripe.Subscription, opts: { couponMissing?: boolean; updateFails?: boolean } = {}) {
  const update = vi.fn(async () => {
    if (opts.updateFails) {
      throw new Error("card_declined");
    }
    return sub;
  });
  const retrieveCoupon = vi.fn(async () => {
    if (opts.couponMissing) {
      throw Object.assign(new Error("No such coupon"), { statusCode: 404, code: "resource_missing" });
    }
    return { id: "curvi_save_30pct_3mo", valid: true };
  });
  const createCoupon = vi.fn(async (params: Stripe.CouponCreateParams) => ({ id: params.id, valid: true }));
  const stripe = {
    subscriptions: { retrieve: vi.fn(async () => sub), update },
    coupons: { retrieve: retrieveCoupon, create: createCoupon },
  } as unknown as Stripe;
  return { stripe, update, retrieveCoupon, createCoupon };
}

function deps(stripe: Stripe | null, state: Partial<CancelState> = {}) {
  const records: NewCancelFlow[] = [];
  const d: CancelDeps = {
    stripe,
    priceTable: table,
    priceIdFor: (tier, cadence) => (tier === "starter" && cadence === "monthly" ? "price_starter_m" : undefined),
    now: () => NOW,
    loadState: async () => ({ usedOffers: new Set<SaveOfferKind>(), pending: null, ...state }),
    record: async (row) => {
      records.push(row);
    },
  };
  return { deps: d, records };
}

const workspace = { id: "ws-1", plan: "growth" };
const account: BillingAccount = {
  stripeCustomerId: "cus_1",
  subscription: { externalId: "sub_1", tier: "growth", status: "active", periodEnd: "2026-10-15T00:00:00.000Z" },
};
const base = { workspace, account, userId: "user-1", reason: "too_expensive" as const, detail: "  Budget cut  " };

describe("cancelTier", () => {
  it("uses the open subscription's tier, then the workspace plan, and nothing on Free", () => {
    expect(cancelTier(workspace, account)).toBe("growth");
    expect(cancelTier({ id: "w", plan: "pro" }, { stripeCustomerId: null, subscription: null })).toBe("pro");
    expect(cancelTier({ id: "w", plan: "free" }, { stripeCustomerId: null, subscription: null })).toBeNull();
  });
});

describe("applyCancelChoice with Stripe", () => {
  it("pauses collection and records the outcome with the resume date", async () => {
    const { stripe, update } = fakeStripe(subscription());
    const { deps: d, records } = deps(stripe);
    const result = await applyCancelChoice(d, { ...base, choice: "pause" });
    expect(result.ok).toBe(true);
    expect(update).toHaveBeenCalledWith(
      "sub_1",
      { pause_collection: { behavior: "void", resumes_at: Math.floor(Date.parse("2026-10-28T12:00:00Z") / 1000) } },
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      workspaceId: "ws-1",
      userId: "user-1",
      reason: "too_expensive",
      detail: "Budget cut",
      fromTier: "growth",
      outcome: "paused",
      stripeApplied: true,
      stripeSubscriptionId: "sub_1",
      offersShown: ["pause", "downgrade", "discount"],
    });
    expect(result.ok && result.notice).toContain("paused until October 28, 2026");
  });

  it("moves to the smaller plan's price", async () => {
    const { stripe, update } = fakeStripe(subscription());
    const { deps: d, records } = deps(stripe);
    const result = await applyCancelChoice(d, { ...base, choice: "downgrade" });
    expect(result.ok).toBe(true);
    expect(update).toHaveBeenCalledWith(
      "sub_1",
      {
        items: [{ id: "si_1", price: "price_starter_m", quantity: 1 }],
        proration_behavior: "none",
        metadata: { plan: "starter" },
      },
      expect.anything(),
    );
    expect(records[0]).toMatchObject({ outcome: "downgraded", toTier: "starter", stripeApplied: true });
  });

  it("creates the save coupon on first use and applies it through discounts", async () => {
    const { stripe, update, createCoupon } = fakeStripe(subscription(), { couponMissing: true });
    const { deps: d, records } = deps(stripe);
    const result = await applyCancelChoice(d, { ...base, choice: "discount" });
    expect(result.ok).toBe(true);
    expect(createCoupon).toHaveBeenCalledWith(
      expect.objectContaining({ id: "curvi_save_30pct_3mo", duration: "repeating" }),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(update).toHaveBeenCalledWith("sub_1", { discounts: [{ coupon: "curvi_save_30pct_3mo" }] }, expect.anything());
    expect(records[0]).toMatchObject({ outcome: "discounted", stripeApplied: true });
  });

  it("reuses an existing coupon and refuses one that is no longer valid", async () => {
    const reuse = fakeStripe(subscription());
    const reuseDeps = deps(reuse.stripe);
    expect((await applyCancelChoice(reuseDeps.deps, { ...base, choice: "discount" })).ok).toBe(true);
    expect(reuse.createCoupon).not.toHaveBeenCalled();

    const expired = fakeStripe(subscription());
    expired.retrieveCoupon.mockResolvedValueOnce({ id: "curvi_save_30pct_3mo", valid: false });
    const expiredDeps = deps(expired.stripe);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await applyCancelChoice(expiredDeps.deps, { ...base, choice: "discount" });
    errors.mockRestore();
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(expired.update).not.toHaveBeenCalled();
    expect(expiredDeps.records[0].error).toContain("no longer valid");
  });

  it("cancels at period end with the reason, and records when it takes effect", async () => {
    const { stripe, update } = fakeStripe(subscription());
    const { deps: d, records } = deps(stripe);
    const result = await applyCancelChoice(d, { ...base, choice: "cancel" });
    expect(update).toHaveBeenCalledWith(
      "sub_1",
      { cancel_at_period_end: true, cancellation_details: { feedback: "too_expensive", comment: "Budget cut" } },
      expect.anything(),
    );
    expect(records[0]).toMatchObject({ outcome: "canceled", stripeApplied: true });
    expect(records[0].effectiveAt).toEqual(new Date(PERIOD_END * 1000));
    expect(result.ok && result.notice).toContain("stays active until October 15, 2026");
  });

  it("records keeping the plan without touching Stripe", async () => {
    const { stripe, update } = fakeStripe(subscription());
    const { deps: d, records } = deps(stripe);
    const result = await applyCancelChoice(d, { ...base, choice: "keep" });
    expect(result.ok).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({ outcome: "kept", stripeApplied: false });
  });

  it("refuses an offer already taken, and pause or discount on an annual plan", async () => {
    const { stripe, update } = fakeStripe(subscription());
    const used = deps(stripe, { usedOffers: new Set<SaveOfferKind>(["discount"]) });
    const again = await applyCancelChoice(used.deps, { ...base, choice: "discount" });
    expect(again).toMatchObject({ ok: false, status: 409, error: "offer_unavailable" });

    const annual = fakeStripe(subscription({}, "price_growth_a"));
    const annualDeps = deps(annual.stripe);
    expect(await applyCancelChoice(annualDeps.deps, { ...base, choice: "pause" })).toMatchObject({ status: 409 });
    expect(update).not.toHaveBeenCalled();
    expect(annual.update).not.toHaveBeenCalled();
    expect(used.records).toHaveLength(0);
  });

  it("reports a Stripe failure plainly and records it with the error", async () => {
    const { stripe } = fakeStripe(subscription(), { updateFails: true });
    const { deps: d, records } = deps(stripe);
    const result = await applyCancelChoice(d, { ...base, choice: "cancel" });
    expect(result).toMatchObject({ ok: false, status: 502, error: "stripe_error" });
    expect(result.ok ? "" : result.notice).toContain("Nothing changed");
    expect(records[0]).toMatchObject({ outcome: "canceled", stripeApplied: false });
    expect(records[0].error).toContain("card_declined");
  });

  it("answers 409 when the subscription is already set to end or paused", async () => {
    const ending = fakeStripe(subscription({ cancel_at_period_end: true }));
    expect(await applyCancelChoice(deps(ending.stripe).deps, { ...base, choice: "cancel" })).toMatchObject({
      status: 409,
      error: "already_pending",
    });
    const paused = fakeStripe(subscription({ pause_collection: { behavior: "void", resumes_at: null } } as never));
    expect(await cancelOptions(deps(paused.stripe).deps, workspace, account)).toMatchObject({ status: 409 });
    const pending = deps(null, { pending: { outcome: "canceled", effectiveAt: "2026-10-15T00:00:00.000Z" } });
    expect(await cancelOptions(pending.deps, workspace, account)).toMatchObject({ status: 409 });
  });
});

describe("applyCancelChoice without Stripe", () => {
  it("shows the offers and records the choice without calling Stripe", async () => {
    const { deps: d, records } = deps(null);
    const noSub: BillingAccount = { stripeCustomerId: null, subscription: null };
    const options = await cancelOptions(d, workspace, noSub);
    expect(options.ok && options.options.live).toBe(false);
    expect(options.ok && options.options.offers.map((o) => o.kind)).toEqual(["pause", "downgrade", "discount"]);

    const result = await applyCancelChoice(d, { ...base, account: noSub, choice: "discount" });
    expect(result.ok).toBe(true);
    expect(result.ok && result.stripeApplied).toBe(false);
    expect(result.ok && result.notice).toContain("nothing is charged or changed today");
    expect(records[0]).toMatchObject({ outcome: "discounted", stripeApplied: false, stripeSubscriptionId: null });
  });

  it("refuses the flow on the Free plan", async () => {
    const { deps: d } = deps(null);
    const result = await applyCancelChoice(d, {
      ...base,
      workspace: { id: "ws-1", plan: "free" },
      account: { stripeCustomerId: null, subscription: null },
      choice: "cancel",
    });
    expect(result).toMatchObject({ ok: false, status: 409, error: "no_plan" });
  });

  it("still reports success when recording fails after the change", async () => {
    const { stripe } = fakeStripe(subscription());
    const { deps: d } = deps(stripe);
    d.record = async () => {
      throw new Error("db down");
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await applyCancelChoice(d, { ...base, choice: "pause" });
    expect(result.ok).toBe(true);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
