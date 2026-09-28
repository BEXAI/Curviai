import { describe, expect, it } from "vitest";
import { retentionOffers, tierByKey } from "@curvi/pipeline/seed";
import {
  addMonths,
  buildCancelParams,
  buildDiscountParams,
  buildDowngradeParams,
  buildPauseParams,
  CANCEL_REASONS,
  downgradeTarget,
  eligibleOffers,
  formatPrice,
  offersForReason,
  outcomeNotice,
  retentionCoupon,
  type SaveOfferKind,
} from "./cancel-flow";

const none = new Set<SaveOfferKind>();

describe("eligibleOffers", () => {
  it("offers pause, a smaller plan and a discount on a monthly plan", () => {
    const offers = eligibleOffers({ tier: "growth", cadence: "monthly", usedOffers: none, hasDiscount: false });
    expect(offers.map((o) => o.kind)).toEqual(["pause", "downgrade", "discount"]);
    const downgrade = offers.find((o) => o.kind === "downgrade")!;
    expect(downgrade.toTier).toBe("starter");
    // Terms come from the seed.
    const starter = tierByKey("starter");
    expect(downgrade.title).toContain(`$${starter.monthlyUsd} a month`);
    const discount = offers.find((o) => o.kind === "discount")!;
    expect(discount.title).toBe(
      `${retentionOffers.discount.percentOff} percent off for ${retentionOffers.discount.months} months`,
    );
    const growth = tierByKey("growth");
    expect(discount.body).toContain(formatPrice((growth.monthlyUsd * (100 - retentionOffers.discount.percentOff)) / 100));
  });

  it("gives each pause and discount once per workspace and never stacks a discount", () => {
    const used = new Set<SaveOfferKind>(["pause", "discount"]);
    expect(eligibleOffers({ tier: "pro", cadence: "monthly", usedOffers: used, hasDiscount: false }).map((o) => o.kind)).toEqual([
      "downgrade",
    ]);
    expect(
      eligibleOffers({ tier: "pro", cadence: "monthly", usedOffers: none, hasDiscount: true }).map((o) => o.kind),
    ).toEqual(["pause", "downgrade"]);
  });

  it("keeps pause and discount to monthly plans, and has no smaller plan below Starter", () => {
    expect(eligibleOffers({ tier: "growth", cadence: "annual", usedOffers: none, hasDiscount: false }).map((o) => o.kind)).toEqual([
      "downgrade",
    ]);
    expect(eligibleOffers({ tier: "starter", cadence: "annual", usedOffers: none, hasDiscount: false })).toEqual([]);
    expect(downgradeTarget("starter")).toBeNull();
    expect(downgradeTarget("agency")).toBe("pro");
  });

  it("prices an annual downgrade at the annual rate", () => {
    const [offer] = eligibleOffers({ tier: "growth", cadence: "annual", usedOffers: none, hasDiscount: false });
    expect(offer.body).toContain(`$${tierByKey("starter").annualUsdPerMonth * 12}`);
  });

  it("orders offers by reason", () => {
    const offers = eligibleOffers({ tier: "growth", cadence: null, usedOffers: none, hasDiscount: false });
    expect(offersForReason(offers, "too_expensive").map((o) => o.kind)).toEqual(["discount", "downgrade", "pause"]);
    expect(offersForReason(offers, "unused").map((o) => o.kind)).toEqual(["pause", "downgrade", "discount"]);
    expect(offersForReason(offers, "low_quality")[0].kind).toBe("discount");
  });

  it("writes every reason and offer in plain words with no dashes or arrows", () => {
    const offers = eligibleOffers({ tier: "agency", cadence: "monthly", usedOffers: none, hasDiscount: false });
    const texts = [
      ...CANCEL_REASONS.map((r) => r.label),
      ...offers.flatMap((o) => [o.title, o.body, o.action]),
      ...(["paused", "downgraded", "discounted", "canceled", "kept"] as const).flatMap((outcome) => [
        outcomeNotice({ outcome, stripeApplied: true, effectiveAt: new Date("2026-10-28T00:00:00Z"), toTier: "pro" }),
        outcomeNotice({ outcome, stripeApplied: false, effectiveAt: null }),
      ]),
    ];
    for (const text of texts) {
      expect(text).not.toMatch(/[‒-―←-⇿]|\s-\s|--/);
    }
  });
});

describe("Stripe parameters", () => {
  it("pauses collection with voided invoices until the seed pause ends", () => {
    const now = new Date("2026-01-31T10:00:00Z");
    const { params, resumesAt } = buildPauseParams(now, 1);
    expect(resumesAt.toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(params).toEqual({
      pause_collection: { behavior: "void", resumes_at: Math.floor(resumesAt.getTime() / 1000) },
    });
  });

  it("moves the single item to the smaller price without proration", () => {
    expect(buildDowngradeParams({ itemId: "si_1", priceId: "price_starter", toTier: "starter" })).toEqual({
      items: [{ id: "si_1", price: "price_starter", quantity: 1 }],
      proration_behavior: "none",
      metadata: { plan: "starter" },
    });
  });

  it("applies the coupon through discounts, not the retired coupon parameter", () => {
    expect(buildDiscountParams("curvi_save")).toEqual({ discounts: [{ coupon: "curvi_save" }] });
  });

  it("cancels at period end with Stripe's feedback value and a trimmed comment", () => {
    expect(buildCancelParams("too_expensive", "x".repeat(600))).toEqual({
      cancel_at_period_end: true,
      cancellation_details: { feedback: "too_expensive", comment: "x".repeat(500) },
    });
    expect(buildCancelParams("other", null)).toEqual({
      cancel_at_period_end: true,
      cancellation_details: { feedback: "other" },
    });
  });

  it("derives the coupon from the seed terms", () => {
    const coupon = retentionCoupon();
    const { percentOff, months } = retentionOffers.discount;
    expect(coupon.id).toBe(`curvi_save_${percentOff}pct_${months}mo`);
    expect(coupon.params).toMatchObject({
      id: coupon.id,
      percent_off: percentOff,
      duration: "repeating",
      duration_in_months: months,
    });
    expect((coupon.params.name ?? "").length).toBeLessThanOrEqual(40);
  });

  it("adds calendar months and clamps to the month's end", () => {
    expect(addMonths(new Date("2026-03-31T00:00:00Z"), 1).toISOString()).toBe("2026-04-30T00:00:00.000Z");
    expect(addMonths(new Date("2026-12-15T00:00:00Z"), 1).toISOString()).toBe("2027-01-15T00:00:00.000Z");
  });
});
