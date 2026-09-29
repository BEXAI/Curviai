import { describe, expect, it } from "vitest";
import { creditCosts, presets } from "@curvi/pipeline/seed";
import {
  DEFAULT_VARIANTS_PER_PRODUCT,
  TOP_PRODUCTS_PER_DROP,
  dropEligible,
  planWeeklyDrops,
  remembersScenesOff,
  weekNumber,
  type DropWorkspace,
} from "./drops";

const MONDAY = new Date("2026-09-21T12:00:00Z");

function workspace(overrides: Partial<DropWorkspace> = {}): DropWorkspace {
  return {
    id: "ws1",
    tier: "growth",
    active: true,
    products: [
      { id: "p1", name: "Mug", performanceScore: 90, useContexts: ["kitchen counter", "office desk"] },
      { id: "p2", name: "Bottle", performanceScore: 70, useContexts: ["gym bag"] },
      { id: "p3", name: "Board", performanceScore: 80, useContexts: ["dinner table"] },
      { id: "p4", name: "Coaster", performanceScore: 10, useContexts: ["coffee table"] },
    ],
    ...overrides,
  };
}

describe("dropEligible", () => {
  it("derives eligibility from the tier seed rows", () => {
    expect(dropEligible("free")).toBe(false);
    expect(dropEligible("starter")).toBe(false);
    expect(dropEligible("growth")).toBe(true);
    expect(dropEligible("pro")).toBe(true);
    expect(dropEligible("agency")).toBe(true);
  });
});

describe("planWeeklyDrops", () => {
  it("skips inactive workspaces", () => {
    const result = planWeeklyDrops([workspace({ active: false })], { now: MONDAY });
    expect(result.plans).toEqual([]);
    expect(result.skipped).toEqual([{ workspaceId: "ws1", reason: "workspace inactive" }]);
  });

  it("skips workspaces on an ineligible tier", () => {
    const result = planWeeklyDrops([workspace({ tier: "starter" })], { now: MONDAY });
    expect(result.plans).toEqual([]);
    expect(result.skipped[0].reason).toBe("plan tier not eligible");
  });

  it("skips workspaces with no products", () => {
    const result = planWeeklyDrops([workspace({ products: [] })], { now: MONDAY });
    expect(result.skipped[0].reason).toBe("no products");
  });

  it("plans variants for the top 3 products by performance", () => {
    const result = planWeeklyDrops([workspace()], { now: MONDAY });
    expect(result.plans).toHaveLength(1);
    const plan = result.plans[0];
    const productIds = [...new Set(plan.items.map((i) => i.productId))];
    expect(productIds).toEqual(["p1", "p3", "p2"]);
    expect(productIds).toHaveLength(TOP_PRODUCTS_PER_DROP);
    expect(plan.items).toHaveLength(TOP_PRODUCTS_PER_DROP * DEFAULT_VARIANTS_PER_PRODUCT);
  });

  it("prices every variant from the seed credit costs", () => {
    const result = planWeeklyDrops([workspace()], { now: MONDAY });
    for (const item of result.plans[0].items) {
      expect(item.credits).toBe(creditCosts.generativeStill);
      expect(item.shotType).toBe("lifestyle");
      expect(Object.keys(presets)).toContain(item.preset);
    }
  });

  it("rotates presets so the two variants of a product differ", () => {
    const result = planWeeklyDrops([workspace()], { now: MONDAY });
    const forP1 = result.plans[0].items.filter((i) => i.productId === "p1");
    expect(forP1).toHaveLength(2);
    expect(forP1[0].preset).not.toBe(forP1[1].preset);
  });

  it("is deterministic for the same date and changes across weeks", () => {
    const a = planWeeklyDrops([workspace()], { now: MONDAY });
    const b = planWeeklyDrops([workspace()], { now: new Date(MONDAY) });
    expect(a).toEqual(b);

    const nextWeek = new Date("2026-09-28T12:00:00Z");
    expect(weekNumber(nextWeek)).toBe(weekNumber(MONDAY) + 1);
    const c = planWeeklyDrops([workspace()], { now: nextWeek });
    expect(c.plans[0].items[0].preset).not.toBe(a.plans[0].items[0].preset);
  });

  it("falls back to a generic scene when a product has no use contexts", () => {
    const ws = workspace({
      products: [{ id: "p1", name: "Mug", performanceScore: 90 }],
    });
    const result = planWeeklyDrops([ws], { now: MONDAY });
    expect(result.plans[0].items.every((i) => i.scene === "everyday use scene")).toBe(true);
  });
});

describe("remembered choices in the drop (PHASE_15 P1)", () => {
  it("reads scenes off from the remembered choices, leniently", () => {
    expect(remembersScenesOff(undefined)).toBe(false);
    expect(remembersScenesOff(null)).toBe(false);
    expect(remembersScenesOff("keep")).toBe(false);
    expect(remembersScenesOff({ v: 1 })).toBe(false);
    expect(remembersScenesOff({ background: "remove", extras: { scenes: false } })).toBe(true);
    // Keep defaults every extra to off unless the record turned scenes on.
    expect(remembersScenesOff({ background: "keep", extras: {} })).toBe(true);
    expect(remembersScenesOff({ background: "keep", extras: { scenes: true } })).toBe(false);
    // Fields newer than this worker never stop it reading the record.
    expect(remembersScenesOff({ background: "remove", sceneCount: 2, extras: { scenes: true } })).toBe(false);
  });

  it("skips scene variants for a product whose remembered choices turn scenes off", () => {
    const base = workspace();
    const ws = workspace({
      products: base.products.map((p) => (p.id === "p1" ? { ...p, outputDefaults: { background: "keep", extras: {} } } : p)),
    });
    const result = planWeeklyDrops([ws], { now: MONDAY });
    const ids = new Set(result.plans[0].items.map((i) => i.productId));
    expect(ids.has("p1")).toBe(false);
    expect(ids).toEqual(new Set(["p3", "p2"]));
  });

  it("skips the workspace when every top product turned scenes off", () => {
    const off = { background: "remove", extras: { scenes: false } };
    const ws = workspace({ products: [{ id: "p1", name: "Mug", performanceScore: 90, outputDefaults: off }] });
    const result = planWeeklyDrops([ws], { now: MONDAY });
    expect(result.plans).toEqual([]);
    expect(result.skipped).toEqual([{ workspaceId: "ws1", reason: "scenes turned off" }]);
  });
});
