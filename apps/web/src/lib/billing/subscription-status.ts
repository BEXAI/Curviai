/**
 * What each Stripe subscription status means for the workspace. Client safe.
 */

/** Statuses that keep the paid plan. past_due keeps it while Stripe retries
 * the card; the final failure cancels the subscription and the plan returns
 * to free. */
export const PLAN_KEEPING_STATUSES: ReadonlySet<string> = new Set(["active", "trialing", "past_due"]);

/** Statuses of a subscription that still exists in Stripe and must be
 * changed through the portal rather than replaced by a second checkout. */
export const OPEN_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "paused",
]);

/** Status given to an older active row when a newer subscription becomes
 * active for the same workspace, so the one active row index never breaks. */
export const SUPERSEDED_STATUS = "superseded";

/** A renewal failed and the card needs updating (money-dunning). */
export function needsCardUpdate(status: string | null | undefined): boolean {
  return status === "past_due" || status === "unpaid";
}

export function keepsPaidPlan(status: string | null | undefined): boolean {
  return typeof status === "string" && PLAN_KEEPING_STATUSES.has(status);
}

export function isOpenSubscription(status: string | null | undefined): boolean {
  return typeof status === "string" && OPEN_SUBSCRIPTION_STATUSES.has(status);
}
