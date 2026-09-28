import { describe, expect, it } from "vitest";
import {
  acceptsSubscriptionStatus,
  isOpenSubscription,
  keepsPaidPlan,
  needsCardUpdate,
  pastDueMessage,
} from "./subscription-status";

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

  it("ignores a status that can only come from an older event", () => {
    // Nothing leaves canceled or incomplete_expired.
    for (const incoming of ["active", "past_due", "trialing", "incomplete", "unpaid"]) {
      expect(acceptsSubscriptionStatus("canceled", incoming), incoming).toBe(false);
      expect(acceptsSubscriptionStatus("incomplete_expired", incoming), incoming).toBe(false);
    }
    // Nothing goes back to incomplete once the first payment went through.
    for (const current of ["active", "past_due", "trialing", "unpaid", "paused", "superseded"]) {
      expect(acceptsSubscriptionStatus(current, "incomplete"), current).toBe(false);
      expect(acceptsSubscriptionStatus(current, "incomplete_expired"), current).toBe(false);
    }
  });

  it("accepts every forward move Stripe makes", () => {
    expect(acceptsSubscriptionStatus(null, "incomplete")).toBe(true);
    expect(acceptsSubscriptionStatus("incomplete", "active")).toBe(true);
    expect(acceptsSubscriptionStatus("incomplete", "incomplete_expired")).toBe(true);
    expect(acceptsSubscriptionStatus("active", "past_due")).toBe(true);
    expect(acceptsSubscriptionStatus("past_due", "active")).toBe(true);
    expect(acceptsSubscriptionStatus("past_due", "canceled")).toBe(true);
    expect(acceptsSubscriptionStatus("canceled", "canceled")).toBe(true);
  });

  it("words the past due notice for who is reading it", () => {
    expect(pastDueMessage("past_due", "Growth", true)).toBe(
      "Stripe will try the card again over the next few days. Update the card to keep the Growth plan.",
    );
    expect(pastDueMessage("unpaid", "Pro", false)).toContain("Ask the workspace owner to update the card");
  });
});
