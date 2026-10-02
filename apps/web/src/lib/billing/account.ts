/**
 * Server side read of a workspace's billing state: the Stripe customer and
 * the current subscription. Reads go through the owner connection in db mode;
 * demo mode has no billing rows, so everything reads as empty.
 */

import { and, eq, events } from "@curvi/db";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { canManageBilling } from "./access";
import { hasStripeApiKey } from "@/lib/env";
import { getStripe } from "./stripe";
import { withCheckoutLock } from "./checkout-guard";
import { buildPriceTable } from "./price-table";
import { recoverPendingSchedule } from "./scheduled-change";
import { isBillingCadence, tierDisplayName, type BillingCadence } from "./plans";
import { isOpenSubscription, keepsPaidPlan, needsCardUpdate, pastDueMessage } from "./subscription-status";

export interface SubscriptionView {
  externalId: string | null;
  tier: string | null;
  status: string;
  periodEnd: string | null;
  /** subscriptions.cadence (P20-07), written by the webhook from the
   * price's interval; null for a row written before it existed. */
  cadence?: BillingCadence | null;
  attachedScheduleId?: string | null;
  scheduleSyncFailed?: boolean;
  pending?: { tier: string; cadence: BillingCadence; at: string; scheduleId: string } | null;
}

export interface BillingAccount {
  stripeCustomerId: string | null;
  /** The subscription that decides the plan, or the latest one on record. */
  subscription: SubscriptionView | null;
}

export function hasOpenSubscription(account: BillingAccount): boolean {
  return isOpenSubscription(account.subscription?.status);
}

export async function loadBillingAccount(workspaceId: string, options: { refreshSchedule?: boolean } = {}): Promise<BillingAccount> {
  if (!isDbMode()) {
    return { stripeCustomerId: null, subscription: null };
  }
  const db = getDb();
  if (options.refreshSchedule && hasStripeApiKey()) {
    try {
      return await withCheckoutLock(db, workspaceId, async () => {
        const account = await loadBillingAccount(workspaceId);
        if (!account.stripeCustomerId || !account.subscription?.externalId) return account;
        const attached = await recoverPendingSchedule(db, getStripe(), { workspaceId,
          customerId: account.stripeCustomerId, subscriptionId: account.subscription.externalId, prices: buildPriceTable() });
        const refreshed = await loadBillingAccount(workspaceId);
        return { ...refreshed, subscription: refreshed.subscription ? { ...refreshed.subscription, attachedScheduleId: attached?.scheduleId ?? null } : null };
      });
    } catch {
      const account = await loadBillingAccount(workspaceId);
      return { ...account, subscription: account.subscription ? { ...account.subscription, scheduleSyncFailed: true } : null };
    }
  }

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
          cadence: isBillingCadence(chosen.cadence) ? chosen.cadence : null,
          pending: chosen.pendingTier && isBillingCadence(chosen.pendingCadence) && chosen.pendingAt && chosen.pendingScheduleId
            ? { tier: chosen.pendingTier, cadence: chosen.pendingCadence, at: chosen.pendingAt.toISOString(), scheduleId: chosen.pendingScheduleId }
            : null,
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
