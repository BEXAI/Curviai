import { describe, expect, it } from "vitest";
import { packsForCredits } from "@/lib/marketing-facts";
import { paidTiers, priceForCadence } from "@/lib/billing/plans";
import { formatPerPackUsd, formatSeedDate, perPackUsd } from "./per-pack";

// Per pack price framing (P18-21): every number from the seed, never a
// literal, and never cheaper than the real monthly price over the packs.

describe("perPackUsd", () => {
  it("divides each paid plan's price by its typical packs, rounded up to the cent", () => {
    for (const tier of paidTiers) {
      for (const cadence of ["monthly", "annual"] as const) {
        const price = priceForCadence(tier, cadence);
        const packs = packsForCredits(tier.creditsPerMonth);
        const perPack = perPackUsd(price.perMonthUsd, tier.creditsPerMonth);
        expect(perPack, `${tier.key} ${cadence}`).not.toBeNull();
        expect(perPack).toBe(Math.ceil((price.perMonthUsd / packs) * 100 - 1e-9) / 100);
        // Never understated: the packs at that price cover the real price.
        expect((perPack as number) * packs).toBeGreaterThanOrEqual(price.perMonthUsd - 1e-9);
        expect((perPack as number) * packs - price.perMonthUsd).toBeLessThan(packs * 0.01);
      }
    }
  });

  it("drops the line for a plan that covers no pack or costs nothing", () => {
    expect(perPackUsd(0, 1000)).toBeNull();
    expect(perPackUsd(29, 0)).toBeNull();
  });

  it("formats dollars with cents", () => {
    expect(formatPerPackUsd(1.1)).toBe("$1.10");
    expect(formatPerPackUsd(0.8)).toBe("$0.80");
  });
});

describe("formatSeedDate", () => {
  it("reads a seed day as a UTC calendar day", () => {
    expect(formatSeedDate("2026-10-01")).toBe("October 1, 2026");
    expect(formatSeedDate("2026-11-30")).toBe("November 30, 2026");
    expect(formatSeedDate("later")).toBe("later");
  });
});
