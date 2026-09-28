import { describe, expect, it } from "vitest";
import { isOpenSubscription, keepsPaidPlan, needsCardUpdate } from "./subscription-status";

describe("subscription status rules", () => {
  it("keeps the paid plan while Stripe retries a failed renewal", () => {
    expect(keepsPaidPlan("active")).toBe(true);
    expect(keepsPaidPlan("trialing")).toBe(true);
    expect(keepsPaidPlan("past_due")).toBe(true);
    for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused", "superseded", null]) {
      expect(keepsPaidPlan(status)).toBe(false);
    }
  });

  it("shows the past due banner only when the card needs updating", () => {
    expect(needsCardUpdate("past_due")).toBe(true);
    expect(needsCardUpdate("unpaid")).toBe(true);
    expect(needsCardUpdate("active")).toBe(false);
    expect(needsCardUpdate(undefined)).toBe(false);
  });

  it("sends open subscriptions to the portal instead of a second checkout", () => {
    expect(isOpenSubscription("active")).toBe(true);
    expect(isOpenSubscription("past_due")).toBe(true);
    expect(isOpenSubscription("incomplete")).toBe(false);
    expect(isOpenSubscription("canceled")).toBe(false);
  });
});
