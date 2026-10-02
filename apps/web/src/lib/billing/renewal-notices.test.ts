import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { Db } from "@curvi/db";
import type { ResendEmail } from "@curvi/trigger/spend-alerts";
import type { PriceTable } from "./price-table";
import { renewalNotice, validatePriceNotice, priceNotice, runRenewalNotices, verifiedRenewalTerms, type NoticeSubscription } from "./renewal-notices";

const now = new Date("2026-10-02T00:00:00Z");
const subscription: NoticeSubscription = {
  id: "row_1", externalId: "sub_1", workspaceId: "ws_1", customerId: "cus_1", tier: "growth", cadence: "annual",
  createdAt: new Date("2025-11-11T00:00:00Z"), periodEnd: new Date("2026-11-11T00:00:00Z"), cancelAtPeriodEnd: false,
};
const quote = { tier: "growth" as const, cadence: "annual" as const, priceCents: 79000 };
describe("billing notices", () => {
  it("selects an annual plan forty days from renewal and gives every retry the same key", () => {
    const first = renewalNotice(subscription, now, "https://curvi.ai", quote);
    expect(first?.subject).toContain("November 11");
    expect(first?.text).toContain("Cancel any time in Billing: https://curvi.ai/app/billing");
    expect(renewalNotice(subscription, new Date("2026-10-03T00:00:00Z"), "https://curvi.ai", quote)?.key).toBe(first?.key);
    expect(renewalNotice({ ...subscription, periodEnd: new Date("2026-10-20Z") }, now, "https://curvi.ai", quote)).toBeNull();
  });
  it("never sends an annual reminder to a monthly plan thirty-one days from renewal", () => {
    expect(renewalNotice({ ...subscription, cadence: "monthly", periodEnd: new Date("2026-11-02Z") }, now, "https://curvi.ai", quote)).toBeNull();
  });
  it("sends monthly anniversary notices once per year and excludes cancellation", () => {
    const monthly = { ...subscription, cadence: "monthly" as const, createdAt: new Date("2025-10-20Z") };
    expect(renewalNotice(monthly, now, "https://curvi.ai", quote)?.key).toBe("yearly_notice:row_1:2026");
    expect(renewalNotice({ ...monthly, createdAt: now }, now, "https://curvi.ai", quote)).toBeNull();
    expect(renewalNotice({ ...subscription, cancelAtPeriodEnd: true }, now, "https://curvi.ai", quote)).toBeNull();
  });
  it("rejects price notice dates outside the seed window and invalid amounts", () => {
    expect(() => validatePriceNotice({ newUsd: 99, effective: new Date("2026-10-23Z") }, now)).not.toThrow();
    for (const date of ["2026-10-08Z", "2026-11-02Z", "invalid"]) {
      expect(() => validatePriceNotice({ newUsd: 99, effective: new Date(date) }, now)).toThrow();
    }
    expect(() => validatePriceNotice({ newUsd: NaN, effective: new Date("2026-10-23Z") }, now)).toThrow();
    expect(priceNotice(subscription, { newUsd: 99, effective: new Date("2026-10-23Z") }, "https://curvi.ai").text).toContain("$99.00 per year");
  });
});

const prices: PriceTable = {
  price_current: { kind: "tier", tier: "growth", cadence: "annual", priceCents: 79000, creditsPerMonth: 100 },
  price_next: { kind: "tier", tier: "starter", cadence: "monthly", priceCents: 2900, creditsPerMonth: 50 },
};
function setup(options: { scheduled?: boolean; nextAnnual?: boolean; currentMonthly?: boolean } = {}) {
  const boundary = Math.floor(subscription.periodEnd.getTime() / 1000);
  const stripePrice = (id: string, annual: boolean, cents: number) => ({ id, currency: "usd", billing_scheme: "per_unit", unit_amount: cents,
    recurring: { interval: annual ? "year" : "month", interval_count: 1, usage_type: "licensed" } });
  const live = { id: "sub_1", customer: "cus_1", status: "active", cancel_at_period_end: false, cancel_at: null, pause_collection: null,
    schedule: options.scheduled === false ? null : "sched_1", items: { data: [{ quantity: 1, current_period_end: boundary,
      price: stripePrice("price_current", !options.currentMonthly, 79123) }] } };
  const schedule = { id: "sched_1", customer: "cus_1", subscription: "sub_1", status: "active", end_behavior: "release",
    phases: [
      { start_date: boundary - 365 * 86400, end_date: boundary, items: [{ quantity: 1, price: "price_current" }] },
      { start_date: boundary, end_date: boundary + 365 * 86400, items: [{ quantity: 1, price: "price_next" }] },
    ] };
  const nextPrice = stripePrice("price_next", Boolean(options.nextAnnual), options.nextAnnual ? 29001 : 2917);
  const api = { subscriptions: { retrieve: vi.fn(async () => live) }, subscriptionSchedules: { retrieve: vi.fn(async () => schedule) },
    prices: { retrieve: vi.fn(async () => nextPrice) }, customers: { retrieve: vi.fn(async () => ({ id: "cus_1", email: "owner@example.com" })) } };
  const stored = { ...subscription, ...(options.currentMonthly ? { cadence: "monthly" as const, createdAt: new Date("2025-10-20Z") } : {}) };
  const table: PriceTable = { ...prices,
    price_current: { ...prices.price_current!, kind: "tier", tier: "growth", cadence: options.currentMonthly ? "monthly" : "annual", priceCents: 79000, creditsPerMonth: 100 },
    price_next: { ...prices.price_next!, kind: "tier", tier: "starter", cadence: options.nextAnnual ? "annual" : "monthly", priceCents: 2900, creditsPerMonth: 50 },
  };
  const db = { execute: vi.fn(async () => [stored]) } as unknown as Db;
  const send = vi.fn(async (_email: ResendEmail) => ({ ok: true }));
  const run = (extra: Partial<Parameters<typeof runRenewalNotices>[0]> = {}) => runRenewalNotices({ db, stripe: api as unknown as Stripe, now, prices: table, send, ...extra });
  return { api, live, schedule, nextPrice, stored, table, send, run };
}

describe("authoritative renewal notice delivery", () => {
  it.each([false, true])("quotes the pending %s cadence and actual Stripe amount when an annual plan changes", async (nextAnnual) => {
    const f = setup({ nextAnnual });
    expect(await f.run()).toMatchObject({ due: 1, sent: 1, failed: 0 });
    const text = f.send.mock.calls[0]![0]!.text;
    expect(text).toContain(`Starter, billed every ${nextAnnual ? "year" : "month"} at ${nextAnnual ? "$290.01" : "$29.17"}`);
    expect(text).not.toContain("Growth");
    expect(f.api.subscriptionSchedules.retrieve).toHaveBeenCalledWith("sched_1", {}, expect.any(Object));
  });
  it("keeps monthly anniversary eligibility while quoting a scheduled annual term", async () => {
    const f = setup({ currentMonthly: true, nextAnnual: true });
    expect(await f.run()).toMatchObject({ sent: 1, failed: 0 });
    expect(f.send.mock.calls[0]![0]).toMatchObject({ idempotencyKey: "yearly_notice:row_1:2026" });
    expect(f.send.mock.calls[0]![0]!.text).toContain("Starter, billed every year at $290.01");
  });
  it("uses the current live amount without a schedule, not a stale catalog amount", async () => {
    const f = setup({ scheduled: false });
    expect(await f.run()).toMatchObject({ sent: 1, failed: 0 });
    expect(f.send.mock.calls[0]![0]!.text).toContain("$791.23");
    expect(f.api.subscriptionSchedules.retrieve).not.toHaveBeenCalled();
  });
  it.each(["customer", "subscription", "price", "amount", "cadence", "currency", "gap", "lookup"])("fails without delivery when %s proof is invalid", async (invalid) => {
    const f = setup();
    if (invalid === "customer") f.live.customer = "cus_other";
    if (invalid === "subscription") f.schedule.subscription = "sub_other";
    if (invalid === "price") f.schedule.phases[1]!.items[0]!.price = "unknown_price";
    if (invalid === "amount") f.nextPrice.unit_amount = NaN;
    if (invalid === "cadence") f.nextPrice.recurring.interval = "year";
    if (invalid === "currency") f.nextPrice.currency = "eur";
    if (invalid === "gap") f.schedule.phases[1]!.start_date++;
    if (invalid === "lookup") f.api.subscriptionSchedules.retrieve.mockRejectedValue(new Error("unavailable"));
    expect(await f.run()).toMatchObject({ sent: 0, failed: 1 });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("checks the schedule's own customer and the recipient customer identity", async () => {
    const f = setup();
    f.schedule.customer = "cus_other";
    await expect(verifiedRenewalTerms(f.api as unknown as Stripe, f.stored, f.table, now)).rejects.toThrow("could not be verified");
    f.schedule.customer = "cus_1";
    f.api.customers.retrieve.mockResolvedValue({ id: "cus_other", email: "wrong@example.com" });
    expect(await f.run()).toMatchObject({ sent: 0, failed: 1 });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("retries failed proof and sends only after authoritative verification succeeds", async () => {
    const f = setup();
    f.api.subscriptionSchedules.retrieve.mockRejectedValueOnce(new Error("timeout"));
    expect(await f.run()).toMatchObject({ failed: 1, sent: 0 });
    expect(await f.run()).toMatchObject({ failed: 0, sent: 1 });
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("does not deliver a stale DB reminder after live cancellation", async () => {
    const f = setup();
    f.live.cancel_at_period_end = true;
    expect(await f.run()).toMatchObject({ due: 0, sent: 0, failed: 0 });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("retains the final released price but excludes scheduled cancellation at the boundary", async () => {
    const f = setup();
    f.schedule.phases = [f.schedule.phases[0]!];
    f.api.prices.retrieve.mockResolvedValue(f.live.items.data[0]!.price);
    expect(await f.run()).toMatchObject({ sent: 1, failed: 0 });
    expect(f.send.mock.calls[0]![0]!.text).toContain("Growth, billed every year at $791.23");
    f.schedule.end_behavior = "cancel";
    expect(await f.run()).toMatchObject({ sent: 0, failed: 0 });
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("does not guess terms when another scheduled transition follows the next renewal", async () => {
    const f = setup();
    const next = f.schedule.phases[1]!;
    f.schedule.phases.push({ ...next, start_date: next.end_date, end_date: next.end_date + 30 * 86400 });
    expect(await f.run()).toMatchObject({ sent: 0, failed: 1 });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("fails closed when an earlier phase resets the billing anchor before the stored renewal date", async () => {
    const f = setup(); // Now October 2; the current period ends November 11.
    const transition = new Date("2026-10-20T00:00:00Z").getTime() / 1000;
    f.schedule.phases[0]!.end_date = transition;
    Object.assign(f.schedule.phases[1]!, {
      start_date: transition, end_date: new Date("2026-11-20T00:00:00Z").getTime() / 1000,
      billing_cycle_anchor: "phase_start",
    });
    expect(await f.run()).toMatchObject({ due: 0, sent: 0, failed: 1 });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.api.customers.retrieve).not.toHaveBeenCalled();
  });
  it.each([false, true])("targets price-change declarations at the verified pending cadence (%s)", async (nextAnnual) => {
    const f = setup({ nextAnnual });
    const change = { tier: "growth" as const, cadence: "annual" as const, newUsd: 999, effective: new Date("2026-10-23Z") };
    expect(await f.run({ priceChange: change })).toMatchObject({ due: 0, sent: 0 });
    expect(await f.run({ priceChange: { ...change, tier: "starter", cadence: nextAnnual ? "annual" : "monthly", newUsd: 35 } })).toMatchObject({ due: 1, sent: 1 });
    expect(f.send.mock.calls[0]![0]!.text).toContain(`Starter plan price changes to $35.00 per ${nextAnnual ? "year" : "month"}`);
  });
  it("verifies Stripe terms during a dry run without sending mail", async () => {
    const f = setup();
    expect(await f.run({ dryRun: true })).toMatchObject({ due: 1, sent: 0, failed: 0, dryRun: true });
    expect(f.api.subscriptions.retrieve).toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
});
