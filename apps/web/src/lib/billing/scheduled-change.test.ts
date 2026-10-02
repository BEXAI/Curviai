import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { scheduleDowngrade, keepCurrentPlan, recoverPendingSchedule, scheduleWorkspaceDowngrade } from "./scheduled-change";
import type { PriceTable } from "./price-table";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eq, subscriptions, workspaces, type Db } from "@curvi/db";

const prices: PriceTable = {
  price_growth: { kind: "tier", tier: "growth", cadence: "annual", creditsPerMonth: 100, priceCents: 10000 },
  price_starter: { kind: "tier", tier: "starter", cadence: "monthly", creditsPerMonth: 50, priceCents: 1000 },
};
function fixture() {
  const retrieve = vi.fn().mockResolvedValue({ id: "sub_1", customer: "cus_1", status: "active", schedule: null,
    cancel_at_period_end: false, items: { data: [{ price: { id: "price_growth" }, quantity: 1, current_period_end: 1793491200 }] } });
  const create = vi.fn().mockResolvedValue({ id: "sched_1", current_phase: { start_date: 1761955200 }, phases: [{
    start_date: 1761955200, end_date: 1793491200, metadata: { workspace_id: "ws_1" },
    items: [{ price: "price_growth", quantity: 1 }], discounts: [{ discount: "di_1" }],
  }] });
  const update = vi.fn().mockResolvedValue({ id: "sched_1" });
  const release = vi.fn().mockResolvedValue({ id: "sched_1", status: "released" });
  const retrieveSchedule = vi.fn();
  return { retrieve, retrieveSchedule, create, update, release, stripe: { subscriptions: { retrieve }, subscriptionSchedules: { retrieve: retrieveSchedule, create, update, release } } as unknown as Stripe };
}
const input = { subscriptionId: "sub_1", customerId: "cus_1", targetPriceId: "price_starter", target: { tier: "starter", cadence: "monthly" } as const, prices };

describe("scheduled plan changes", () => {
  it("keeps the paid annual period and its discount intact, changes once at renewal, and never prorates", async () => {
    const f = fixture();
    const result = await scheduleDowngrade(f.stripe, input);
    expect(result.startsAt.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    const params = f.update.mock.calls[0]![1];
    expect(params).toMatchObject({ end_behavior: "release", proration_behavior: "none", phases: [
      { items: [{ price: "price_growth" }], discounts: [{ discount: "di_1" }], metadata: { workspace_id: "ws_1" }, end_date: 1793491200, proration_behavior: "none" },
      { start_date: 1793491200, items: [{ price: "price_starter", quantity: 1 }], duration: { interval: "month", interval_count: 1 }, proration_behavior: "none" },
    ] });
    expect(f.release).not.toHaveBeenCalled();
  });
  it("refuses duplicate schedules and cross-customer access before changing Stripe", async () => {
    const f = fixture();
    await expect(scheduleDowngrade(f.stripe, { ...input, pendingScheduleId: "sched_old" })).rejects.toThrow("Keep your current plan");
    await expect(scheduleDowngrade(f.stripe, { ...input, customerId: "cus_other" })).rejects.toThrow("does not belong");
    expect(f.create).not.toHaveBeenCalled();
  });
  it("releases the new schedule after a failed update", async () => {
    const f = fixture();
    f.update.mockRejectedValue(new Error("Stripe unavailable"));
    await expect(scheduleDowngrade(f.stripe, input)).rejects.toThrow("Stripe unavailable");
    expect(f.release).toHaveBeenCalledWith("sched_1", {}, expect.any(Object));
  });
  it("only releases the matching schedule when keeping the plan", async () => {
    const f = fixture();
    await expect(keepCurrentPlan(f.stripe, { subscriptionId: "sub_1", customerId: "cus_1", scheduleId: "other" })).rejects.toThrow("no longer attached");
    f.retrieve.mockResolvedValue({ customer: "cus_1", schedule: "sched_1" });
    await keepCurrentPlan(f.stripe, { subscriptionId: "sub_1", customerId: "cus_1", scheduleId: "sched_1" });
    expect(f.release).toHaveBeenCalledTimes(1);
  });
});


describe("interrupted schedule recovery", () => {
  let test: Awaited<ReturnType<typeof createTestDb>>;
  let db: TestDb;
  let workspaceId: string;
  beforeAll(async () => {
    test = await createTestDb(); db = test.db;
    const [workspace] = await db.insert(workspaces).values({ name: "Schedule recovery", stripeCustomerId: "cus_1" }).returning();
    workspaceId = workspace.id;
    await db.insert(subscriptions).values({ workspaceId, provider: "stripe", externalId: "sub_1", tier: "growth", cadence: "annual", status: "active" });
  });
  afterAll(async () => { await test.client.close(); });
  const attached = (phases: unknown[]) => ({ id: "sched_1", customer: "cus_1", subscription: "sub_1", phases });
  it("recovers the exact accepted target after update and cleanup responses were both lost", async () => {
    const f = fixture();
    f.update.mockRejectedValue(new Error("response lost after update"));
    f.release.mockRejectedValue(new Error("cleanup unavailable"));
    await expect(scheduleDowngrade(f.stripe, input)).rejects.toThrow("cleanup unavailable");
    f.retrieve.mockResolvedValue({ id: "sub_1", customer: "cus_1", schedule: "sched_1", status: "active" });
    f.retrieveSchedule.mockResolvedValue(attached([{ start_date: 1909094400, items: [{ price: "price_starter", quantity: 1 }] }]));
    const result = await scheduleWorkspaceDowngrade(db as unknown as Db, f.stripe, { ...input, workspaceId });
    expect(result.scheduleId).toBe("sched_1");
    expect(f.create).toHaveBeenCalledTimes(1);
    const [saved] = await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId));
    expect(saved).toMatchObject({ pendingTier: "starter", pendingCadence: "monthly", pendingScheduleId: "sched_1" });
    expect(saved.pendingAt?.getTime()).toBe(1909094400 * 1000);
  });
  it("exposes an empty orphan attachment for Keep current plan without inventing a pending tier", async () => {
    const f = fixture();
    f.retrieve.mockResolvedValue({ id: "sub_1", customer: "cus_1", schedule: "sched_1" });
    f.retrieveSchedule.mockResolvedValue(attached([{ start_date: 1, items: [{ price: "price_growth", quantity: 1 }] }]));
    const recovered = await recoverPendingSchedule(db as unknown as Db, f.stripe, { ...input, workspaceId });
    expect(recovered).toEqual({ scheduleId: "sched_1", startsAt: null, target: null });
    const [saved] = await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId));
    expect(saved.pendingScheduleId).toBeNull();
    await keepCurrentPlan(f.stripe, { subscriptionId: "sub_1", customerId: "cus_1", scheduleId: recovered!.scheduleId });
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("rejects a schedule belonging to another customer before repairing local state", async () => {
    const f = fixture(); f.retrieve.mockResolvedValue({ customer: "cus_1", schedule: "sched_1" });
    f.retrieveSchedule.mockResolvedValue({ ...attached([]), customer: "cus_other" });
    await expect(recoverPendingSchedule(db as unknown as Db, f.stripe, { ...input, workspaceId })).rejects.toThrow("does not belong");
    expect(f.release).not.toHaveBeenCalled();
  });
});
