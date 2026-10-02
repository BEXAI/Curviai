import { describe, expect, it } from "vitest";
import * as seed from "./index";
import { creditExpiry, topUps } from "./index";

// docs/phases/PHASE_20.md Lane 2 Billing terms: the seed facts the credit,
// plan and renewal copy reads (CLAUDE.md rule 2).

/** Every key name in a value, at any depth. */
function keysDeep(value: unknown, seen = new Set<unknown>()): string[] {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return [];
  }
  seen.add(value);
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysDeep(child, seen)]);
}

describe("credit expiry (P20-05, founder decision 10)", () => {
  it("says credits never expire", () => {
    expect(creditExpiry).toEqual({ kind: "none" });
  });

  it("keeps every top up free of an expiry", () => {
    for (const topUp of topUps) {
      expect(Object.keys(topUp).sort()).toEqual(["credits", "usd"]);
    }
  });

  it("exports no rollover policy and no expiry field anywhere in the credit seed", () => {
    const named = seed as Record<string, unknown>;
    expect(named.rolloverPolicy).toBeUndefined();
    const creditSeed = {
      tiers: seed.tiers,
      topUps: seed.topUps,
      foundingMemberOffer: seed.foundingMemberOffer,
      creditCosts: seed.creditCosts,
    };
    for (const key of keysDeep(creditSeed)) {
      expect(key, `credit seed field ${key}`).not.toMatch(/expir|rollover/i);
    }
  });
});

describe("tiers sold online (P20-08, founder decision 6)", () => {
  it("keeps Agency off self serve and sells every other tier online", () => {
    const offline = seed.tiers.filter((tier) => !tier.selfServe).map((tier) => tier.key);
    expect(offline).toEqual(["agency"]);
    for (const tier of seed.tiers) {
      expect(typeof tier.selfServe).toBe("boolean");
    }
  });
});

describe("renewal terms (P20-07, founder decision 4)", () => {
  it("keeps the reminder and notice days inside their windows", () => {
    const n = seed.renewalNotices;
    expect(n.annualWindow).toEqual([30, 45]);
    expect(n.annualDaysBefore).toBeGreaterThanOrEqual(n.annualWindow[0]);
    expect(n.annualDaysBefore).toBeLessThanOrEqual(n.annualWindow[1]);
    expect(n.priceChangeDaysBefore).toBeGreaterThanOrEqual(n.priceChangeWindow[0]);
    expect(n.priceChangeDaysBefore).toBeLessThanOrEqual(n.priceChangeWindow[1]);
    // California keeps consent records at least 3 years (BPC 17602(a)(6)).
    expect(n.consentRecordYears).toBeGreaterThanOrEqual(3);
    expect(n.monthlyYearlyNotice).toBe(true);
  });

  it("shows US prices without tax", () => {
    expect(seed.taxDisplay).toEqual({ pricesIncludeTax: false });
  });
});
