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

/** Statuses Stripe never moves a subscription out of. */
export const TERMINAL_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(["canceled", "incomplete_expired"]);

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

/**
 * Whether a stored subscription row may move from `current` to `incoming`.
 * Stripe does not deliver events in order, so an older event can arrive
 * after a newer one. Stripe itself never moves a subscription out of
 * canceled or incomplete_expired, and never back to incomplete (or on to
 * incomplete_expired) once its first payment went through, so an incoming
 * status that would do either can only come from a stale event and is
 * ignored.
 */
export function acceptsSubscriptionStatus(current: string | null | undefined, incoming: string): boolean {
  if (!current || current === incoming) {
    return true;
  }
  if (TERMINAL_SUBSCRIPTION_STATUSES.has(current)) {
    return false;
  }
  if (incoming === "incomplete" || incoming === "incomplete_expired") {
    return current === "incomplete";
  }
  return true;
}

/** The body of the past due notice on /app/billing and in the app header. */
export function pastDueMessage(status: string | null | undefined, plan: string, canBill: boolean): string {
  const who = canBill ? "Update the card" : "Ask the workspace owner to update the card";
  if (status === "unpaid") {
    return `Stripe has stopped retrying. ${who} in the customer portal and pay the open invoice to get the ${plan} plan back.`;
  }
  return `Stripe will try the card again over the next few days. ${who} to keep the ${plan} plan.`;
}
