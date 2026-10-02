import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { NewCancelFlow } from "@curvi/db";
import type { BillingAccount } from "./account";
import type { SaveOfferKind } from "./cancel-flow";
import { applyCancelChoice, cancelOptions, cancelTier, type CancelDeps, type CancelState } from "./cancel-service";
import type { PriceTable } from "./price-table";
import type { ScheduleReleaseEvent } from "./schedule-release";

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
  const order: string[] = [];
  const release = vi.fn(async (id: string) => {
    order.push(`release:${id}`);
    return { id, status: "released" };
  });
  update.mockImplementation(async () => {
    order.push("update");
    if (opts.updateFails) {
      throw new Error("card_declined");
    }
    return sub;
  });
  // The founder's schedule moves to Starter monthly on November 3, 2026.
  const retrieveSchedule = vi.fn(async (id: string) => ({
    id,
    phases: [
      { start_date: 1_790_000_000, items: [{ price: "price_growth_m" }] },
      { start_date: 1_793_664_000, items: [{ price: "price_starter_m" }] },
    ],
  }));
  const stripe = {
    subscriptions: { retrieve: vi.fn(async () => sub), update },
    subscriptionSchedules: { release, retrieve: retrieveSchedule },
    coupons: { retrieve: retrieveCoupon, create: createCoupon },
  } as unknown as Stripe;
  return { stripe, update, retrieveCoupon, createCoupon, release, order };
}

function deps(stripe: Stripe | null, state: Partial<CancelState> = {}, smallerPlanOffer = true) {
  const records: NewCancelFlow[] = [];
  const d: CancelDeps = {
    stripe,
    // The smaller plan offer is built for P20-06's P1 part; most tests keep
    // it on to cover that path. The seed default (off) is tested below.
    smallerPlanOffer,
    priceTable: table,
    scheduleChange: vi.fn(async () => new Date(PERIOD_END * 1000)),
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

  it("schedules the smaller plan at renewal without changing the current price", async () => {
    const { stripe, update } = fakeStripe(subscription());
    const { deps: d, records } = deps(stripe);
    const result = await applyCancelChoice(d, { ...base, choice: "downgrade" });
    expect(result.ok).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(d.scheduleChange).toHaveBeenCalledWith({ workspaceId: workspace.id, subscriptionId: "sub_1", customerId: "cus_1", tier: "starter", cadence: "monthly", priceId: "price_starter_m" });
    expect(records[0]).toMatchObject({ outcome: "downgraded", toTier: "starter", stripeApplied: true, effectiveAt: new Date(PERIOD_END * 1000) });
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
    expect(result.ok && result.notice).toContain("You keep it until October 15, 2026");
  });

  it("cancels without a reason and records none (P20-07)", async () => {
    const { stripe, update } = fakeStripe(subscription());
    const { deps: d, records } = deps(stripe);
    const result = await applyCancelChoice(d, { ...base, reason: null, detail: null, choice: "cancel" });
    expect(result.ok).toBe(true);
    expect(update).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: true }, expect.anything());
    expect(records[0]).toMatchObject({ reason: null, outcome: "canceled" });
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

  it("answers 409 when the subscription is already set to end", async () => {
    const ending = fakeStripe(subscription({ cancel_at_period_end: true }));
    expect(await applyCancelChoice(deps(ending.stripe).deps, { ...base, choice: "cancel" })).toMatchObject({
      status: 409,
      error: "already_pending",
    });
    const pending = deps(null, { pending: { outcome: "canceled", effectiveAt: "2026-10-15T00:00:00.000Z" } });
    expect(await cancelOptions(pending.deps, workspace, account)).toMatchObject({ status: 409 });
  });

  it("lets a paused subscriber cancel, with no save offers (law and copy review 12)", async () => {
    const paused = fakeStripe(subscription({ pause_collection: { behavior: "void", resumes_at: null } } as never));
    const { deps: d, records } = deps(paused.stripe);
    const options = await cancelOptions(d, workspace, account);
    expect(options).toMatchObject({ ok: true, options: { offers: [] } });
    expect(await applyCancelChoice(d, { ...base, choice: "discount" })).toMatchObject({ status: 409, error: "already_pending" });
    const canceled = await applyCancelChoice(d, { ...base, choice: "cancel" });
    expect(canceled).toMatchObject({ ok: true, outcome: "canceled", stripeApplied: true });
    expect(records.at(-1)).toMatchObject({ outcome: "canceled", stripeApplied: true });
    // Without Stripe facts, a recorded pause still lets the seller cancel.
    const recorded = deps(null, { pending: { outcome: "paused", effectiveAt: "2026-10-28T12:00:00.000Z" } });
    expect(await cancelOptions(recorded.deps, workspace, account)).toMatchObject({ ok: true, options: { offers: [] } });
  });

  it("lets a seller who renewed cancel again, whatever the old cancel_flows row says", async () => {
    // The seller canceled, then renewed in the portal: Stripe says the
    // subscription is no longer ending, but the recorded pass still does.
    const renewed = fakeStripe(subscription({ cancel_at_period_end: false }));
    const stale = deps(renewed.stripe, { pending: { outcome: "canceled", effectiveAt: "2026-10-15T00:00:00.000Z" } });
    expect(await cancelOptions(stale.deps, workspace, account)).toMatchObject({ ok: true });
    const result = await applyCancelChoice(stale.deps, { ...base, choice: "cancel" });
    expect(result).toMatchObject({ ok: true, status: 200, outcome: "canceled", stripeApplied: true });
    expect(renewed.update).toHaveBeenCalledTimes(1);

    const resumed = fakeStripe(subscription());
    const stalePause = deps(resumed.stripe, { pending: { outcome: "paused", effectiveAt: "2026-10-28T12:00:00.000Z" } });
    expect(await cancelOptions(stalePause.deps, workspace, account)).toMatchObject({ ok: true });
  });
});

describe("the P20-06 stopgap in the cancel flow", () => {
  it("hides the smaller plan offer without a schedule writer, and refuses it", async () => {
    const { stripe, update } = fakeStripe(subscription());
    const { deps: d } = deps(stripe, {}, false);
    delete d.smallerPlanOffer;
    delete d.scheduleChange;
    const options = await cancelOptions(d, workspace, account);
    expect(options.ok && options.options.offers.map((o) => o.kind)).toEqual(["pause", "discount"]);
    const result = await applyCancelChoice(d, { ...base, choice: "downgrade" });
    expect(result).toMatchObject({ ok: false, status: 409, error: "offer_unavailable" });
    expect(update).not.toHaveBeenCalled();
  });

  for (const choice of ["pause", "discount", "cancel"] as const) {
    it(`releases an attached schedule before it applies ${choice}, and records it`, async () => {
      const { stripe, release, order } = fakeStripe(subscription({ schedule: "sub_sched_1" } as Partial<Stripe.Subscription>));
      const { deps: d, records } = deps(stripe);
      const result = await applyCancelChoice(d, { ...base, choice });
      expect(result.ok).toBe(true);
      expect(release).toHaveBeenCalledWith("sub_sched_1", {}, expect.objectContaining({ timeout: expect.any(Number) }));
      expect(order[0]).toBe("release:sub_sched_1");
      expect(order).toContain("update");
      expect(records[0]).toMatchObject({ releasedScheduleId: "sub_sched_1", stripeApplied: true });
    });
  }

  it("says at the top of the flow that a choice cancels the scheduled move, and reports the release (law and copy review major 7)", async () => {
    const { stripe } = fakeStripe(subscription({ schedule: "sub_sched_1" } as Partial<Stripe.Subscription>));
    const { deps: d } = deps(stripe);
    const released: ScheduleReleaseEvent[] = [];
    d.onScheduleReleased = async (event) => {
      released.push(event);
    };
    const options = await cancelOptions(d, workspace, account);
    expect(options.ok && options.options.scheduledChange).toBe(
      "Your move to Starter on November 3, 2026 is set up. Pausing billing, taking an offer or canceling here cancels that move.",
    );
    await applyCancelChoice(d, { ...base, choice: "pause" });
    expect(released).toEqual([
      expect.objectContaining({
        workspaceId: "ws-1",
        subscriptionId: "sub_1",
        path: "pause",
        change: expect.objectContaining({ scheduleId: "sub_sched_1", tier: "starter" }),
      }),
    ]);
    // No schedule: nothing to say.
    const plain = await cancelOptions(deps(fakeStripe(subscription()).stripe).deps, workspace, account);
    expect(plain.ok && plain.options.scheduledChange).toBeNull();
  });

  it("says the move was already canceled when Stripe fails after the release", async () => {
    const { stripe } = fakeStripe(subscription({ schedule: "sub_sched_3" } as Partial<Stripe.Subscription>), { updateFails: true });
    const { deps: d, records } = deps(stripe);
    const result = await applyCancelChoice(d, { ...base, choice: "cancel" });
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(result.ok ? "" : result.notice).toBe(
      "Stripe could not make that change just now. Your move to Starter on November 3, 2026 was already canceled, so email hello@curvi.ai if you still want it. Try again in a minute.",
    );
    expect(result.ok ? "" : result.notice).not.toContain("Nothing changed");
    expect(records[0]).toMatchObject({ releasedScheduleId: "sub_sched_3", stripeApplied: false });
  });

  it("releases nothing when no schedule is attached", async () => {
    const { stripe, release } = fakeStripe(subscription());
    const { deps: d, records } = deps(stripe);
    await applyCancelChoice(d, { ...base, choice: "cancel" });
    expect(release).not.toHaveBeenCalled();
    expect(records[0]?.releasedScheduleId).toBeUndefined();
  });

  it("changes nothing else when the release fails", async () => {
    const { stripe, release, update } = fakeStripe(subscription({ schedule: "sub_sched_2" } as Partial<Stripe.Subscription>));
    release.mockRejectedValueOnce(new Error("schedule is canceled"));
    const { deps: d, records } = deps(stripe);
    const result = await applyCancelChoice(d, { ...base, choice: "cancel" });
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(update).not.toHaveBeenCalled();
    expect(records[0]?.stripeApplied).toBe(false);
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
