import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cancelFlows, workspaces } from "@curvi/db";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { eligibleOffers } from "./cancel-flow";
import { loadCancelState } from "./cancel-store";

let db: TestDb;
let client: Awaited<ReturnType<typeof createTestDb>>["client"];
vi.mock("@/lib/services", () => ({ isDbMode: () => true }));
vi.mock("@/lib/services/db", () => ({ getDb: () => db }));

const NOW = new Date("2026-10-02T12:00:00Z");

beforeAll(async () => {
  ({ db, client } = await createTestDb());
});
afterAll(async () => { await client.close(); });

describe("loadCancelState lifetime offers", () => {
  it("keeps old pause and discount usage after more than 200 keep records", async () => {
    const [workspace] = await db.insert(workspaces).values({ name: "Lifetime offers" }).returning();
    await db.insert(cancelFlows).values([
      { workspaceId: workspace.id, fromTier: "growth", outcome: "paused", stripeApplied: true, createdAt: new Date("2026-01-01"), effectiveAt: new Date("2026-02-01") },
      { workspaceId: workspace.id, fromTier: "growth", outcome: "discounted", stripeApplied: true, createdAt: new Date("2026-02-01") },
      ...Array.from({ length: 205 }, (_, index) => ({ workspaceId: workspace.id, fromTier: "growth", outcome: "kept" as const, stripeApplied: false, createdAt: new Date(NOW.getTime() - (206 - index) * 1000) })),
      { workspaceId: workspace.id, fromTier: "growth", outcome: "canceled", stripeApplied: true, createdAt: NOW, effectiveAt: new Date("2026-11-02") },
    ]);

    const state = await loadCancelState(workspace.id, NOW);
    expect([...state.usedOffers].sort()).toEqual(["discount", "pause"]);
    expect(eligibleOffers({ tier: "growth", cadence: "monthly", usedOffers: state.usedOffers, hasDiscount: false, smallerPlanOffer: false })).toEqual([]);
    expect(state.pending).toEqual({ outcome: "canceled", effectiveAt: "2026-11-02T00:00:00.000Z" });
  });

  it("ignores another workspace's offers and failed attempts", async () => {
    const [workspace, other] = await db.insert(workspaces).values([{ name: "Unused offers" }, { name: "Other workspace" }]).returning();
    await db.insert(cancelFlows).values([
      { workspaceId: workspace.id, fromTier: "growth", outcome: "paused", stripeApplied: false, error: "Stripe refused the change" },
      { workspaceId: workspace.id, fromTier: "growth", outcome: "discounted", stripeApplied: false, error: "Stripe refused the change" },
      { workspaceId: other.id, fromTier: "growth", outcome: "paused", stripeApplied: true },
      { workspaceId: other.id, fromTier: "growth", outcome: "discounted", stripeApplied: true },
    ]);

    const state = await loadCancelState(workspace.id, NOW);
    expect([...state.usedOffers]).toEqual([]);
    expect(eligibleOffers({ tier: "growth", cadence: "monthly", usedOffers: state.usedOffers, hasDiscount: false, smallerPlanOffer: false }).map(offer => offer.kind)).toEqual(["pause", "discount"]);
  });
});
