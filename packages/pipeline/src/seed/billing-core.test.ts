import { describe, expect, it } from "vitest";
import { creditOffers } from "../economics";
import { billingReconcile, economics } from "./index";

// docs/phases/PHASE_20.md "Seed summary": Lane 1 Billing core seed values.

describe("billingReconcile (P20-02)", () => {
  it("looks back well inside Stripe's 30 day event window", () => {
    expect(Number.isInteger(billingReconcile.lookbackHours)).toBe(true);
    expect(billingReconcile.lookbackHours).toBeGreaterThan(0);
    // Stripe lists events going back up to 30 days (docs/verification.md).
    expect(billingReconcile.lookbackHours).toBeLessThan(30 * 24);
  });

  it("runs often enough that two runs fit in the lookback, and caps a run", () => {
    expect(Number.isInteger(billingReconcile.everyMinutes)).toBe(true);
    expect(billingReconcile.everyMinutes).toBeGreaterThan(0);
    expect(billingReconcile.everyMinutes * 2).toBeLessThan(billingReconcile.lookbackHours * 60);
    expect(Number.isInteger(billingReconcile.maxEventsPerRun)).toBe(true);
    expect(billingReconcile.maxEventsPerRun).toBeGreaterThanOrEqual(100);
  });

  it("keeps the quiet webhook window positive and inside the event window", () => {
    expect(billingReconcile.quietWebhookDays).toBeGreaterThan(0);
    expect(billingReconcile.quietWebhookDays).toBeLessThan(30);
  });
});

describe("economics (P20-04)", () => {
  it("keeps the margins between 0 and 1, the alert floor under the target, and a sane card fee", () => {
    expect(economics.targetGrossMargin).toBeGreaterThan(0);
    expect(economics.targetGrossMargin).toBeLessThan(1);
    expect(economics.minGrossMargin).toBeGreaterThan(0);
    expect(economics.minGrossMargin).toBeLessThan(economics.targetGrossMargin);
    expect(economics.paymentFee.percent).toBeGreaterThan(0);
    expect(economics.paymentFee.percent).toBeLessThan(0.1);
    expect(economics.paymentFee.fixedUsd).toBeGreaterThanOrEqual(0);
  });

  it("leaves every self serve offer with money after the card fee", () => {
    for (const offer of creditOffers().filter((entry) => entry.selfServe)) {
      expect(offer.netRevenuePerCredit, offer.key).toBeGreaterThan(0);
    }
  });
});
