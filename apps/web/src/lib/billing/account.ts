/**
 * Server side read of a workspace's billing state: the Stripe customer and
 * the current subscription. Reads go through the owner connection in db mode;
 * demo mode has no billing rows, so everything reads as empty.
 */

import { and, eq, events } from "@curvi/db";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { canManageBilling } from "./access";
import { tierDisplayName } from "./plans";
import { isOpenSubscription, keepsPaidPlan, needsCardUpdate, pastDueMessage } from "./subscription-status";

export interface SubscriptionView {
  externalId: string | null;
  tier: string | null;
  status: string;
  periodEnd: string | null;
}

export interface BillingAccount {
  stripeCustomerId: string | null;
  /** The subscription that decides the plan, or the latest one on record. */
  subscription: SubscriptionView | null;
}

export function hasOpenSubscription(account: BillingAccount): boolean {
  return isOpenSubscription(account.subscription?.status);
}

export async function loadBillingAccount(workspaceId: string): Promise<BillingAccount> {
  if (!isDbMode()) {
    return { stripeCustomerId: null, subscription: null };
  }
  const db = getDb();
  const workspace = await db.query.workspaces.findFirst({
    where: (t, { eq }) => eq(t.id, workspaceId),
  });
  const rows = await db.query.subscriptions.findMany({
    where: (t, { eq }) => eq(t.workspaceId, workspaceId),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
  const chosen =
    rows.find((row) => keepsPaidPlan(row.status)) ??
    rows.find((row) => isOpenSubscription(row.status)) ??
    rows[0] ??
    null;
  return {
    stripeCustomerId: workspace?.stripeCustomerId ?? null,
    subscription: chosen
      ? {
          externalId: chosen.externalId,
          tier: chosen.tier,
          status: chosen.status ?? "unknown",
          periodEnd: chosen.periodEnd ? chosen.periodEnd.toISOString() : null,
        }
      : null,
  };
}

/**
 * The past due notice for the app header, or null when the signed in user's
 * workspace has no failing renewal. Reads the same workspace the app pages
 * resolve (the user's membership) without provisioning or settling holds, so
 * it stays cheap on every page. A failed read shows no banner rather than
 * breaking the page.
 */
export async function loadPastDueNotice(userId: string): Promise<string | null> {
  if (!isDbMode()) {
    return null;
  }
  try {
    const membership = await getDb().query.members.findFirst({
      where: (t, { eq }) => eq(t.userId, userId),
    });
    if (!membership) {
      return null;
    }
    const { subscription } = await loadBillingAccount(membership.workspaceId);
    if (!subscription || !needsCardUpdate(subscription.status)) {
      return null;
    }
    const plan = tierDisplayName(subscription.tier ?? "paid");
    return pastDueMessage(subscription.status, plan, canManageBilling(membership.role));
  } catch (error) {
    console.error(JSON.stringify({ msg: "billing: past due check failed", error: String(error) }));
    return null;
  }
}

const CHECKOUT_SESSION_ID = /^cs_[A-Za-z0-9_]{1,250}$/;

/**
 * Whether the webhook has already applied what a returning Checkout paid
 * for: an open subscription for a plan, or the grant row for a top up
 * session. null means the page cannot tell (plan changes from the portal,
 * demo mode) and falls back to watching the plan and balance.
 */
export async function isCheckoutConfirmed(input: {
  workspaceId: string;
  plan: string;
  kind: string | null;
  sessionId: string | null;
  account: BillingAccount;
}): Promise<boolean | null> {
  if (!isDbMode()) {
    return null;
  }
  if (input.kind === "tier") {
    return hasOpenSubscription(input.account) && input.plan !== "free";
  }
  if (input.kind === "topup" && input.sessionId && CHECKOUT_SESSION_ID.test(input.sessionId)) {
    const rows = await getDb()
      .select({ id: events.id })
      .from(events)
      .where(
        and(eq(events.workspaceId, input.workspaceId), eq(events.name, `billing:stripe:checkout:${input.sessionId}`)),
      )
      .limit(1);
    return rows.length > 0;
  }
  return null;
}
