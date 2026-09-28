/**
 * Self serve account deletion (docs/PENDING.md, "Trust and platform").
 *
 * What goes: every workspace the user owns alone, with everything that
 * cascades from it (products, source media rows, packs, steps, assets,
 * variants, pack files, brand kit, credit ledger, subscriptions rows, share
 * links, gallery items, integrations, events, churn scores), every object
 * under that workspace's storage prefix, the user's memberships in other
 * workspaces, and the user's terms acceptance records.
 *
 * What stays: the signup_grants row, which holds the user id, a hash of the
 * normalized email and the credits paid, so deleting an account and signing
 * up again cannot farm a second free grant (migration 0012).
 *
 * Refusals, all checked before anything is deleted:
 * - a pack is still running (after the stale run reconciler has failed any
 *   orphaned run), so no worker writes into a workspace that is going away;
 * - a Stripe subscription is still open and not set to end, so nobody keeps
 *   getting billed for a workspace that no longer exists; the seller cancels
 *   in Billing first. A subscription the seller already set to end (the
 *   cancel flow or the portal set cancel_at_period_end, or cancel_at) does
 *   not block: with Stripe configured its live state is read, and after the
 *   data is gone it is canceled in Stripe at once (no proration, no final
 *   invoice), so no webhook keeps it alive for a deleted workspace. Without
 *   Stripe keys the stored cancel_at_period_end from the webhook, or the
 *   cancel flow's own record of a cancellation Stripe accepted, stands in;
 * - the user owns a workspace that has other members, which would take their
 *   work with it; ownership moves by email for now.
 *
 * The database side runs in one transaction that locks each workspace row
 * FOR UPDATE, the same lock createJob takes first, and checks for running
 * packs again under it, so a pack started in another tab either commits
 * before the check (and refuses the deletion) or waits and then finds no
 * workspace. Storage is cleaned after the commit: the rows that point at the
 * objects are gone by then, so a storage failure is logged with the prefix to
 * clean by hand and never leaves the account half deleted.
 *
 * The Supabase auth user is removed by the caller (the settings action),
 * after this has succeeded.
 */

import type Stripe from "stripe";
import { eq, members, sql, termsAcceptances, workspaces, type Db } from "@curvi/db";
import { cancelStateFromRows } from "@/lib/billing/cancel-store";
import { getStripe, isStripeMissingResource } from "@/lib/billing/stripe";
import { isOpenSubscription, TERMINAL_SUBSCRIPTION_STATUSES } from "@/lib/billing/subscription-status";
import { isStripeConfigured } from "@/lib/env";
import { reconcileStaleJobs } from "@/lib/services/reconcile";
import type { TrustStorage } from "./storage";

export type DeleteAccountRefusal = "pack_running" | "subscription_open" | "shared_workspace" | "not_signed_in";

export type DeleteAccountResult =
  | { ok: true; workspacesDeleted: string[]; objectsDeleted: number; objectsFailed: number }
  | { ok: false; reason: DeleteAccountRefusal; notice: string };

export const DELETE_ACCOUNT_NOTICES: Record<DeleteAccountRefusal, string> = {
  pack_running:
    "A pack is still running. Wait for it to finish or cancel it, then delete your account.",
  subscription_open:
    "You still have a paid plan. Cancel it on the Billing page first, then delete your account.",
  shared_workspace:
    "Your workspace has other members. Email hello@curvi.ai and we will move it to one of them before you delete your account.",
  not_signed_in: "Sign in to delete your account.",
};

const RUNNING_STATUSES_SQL = sql`status not in ('done', 'failed', 'canceled')`;

/** Objects listed per workspace prefix. A workspace with more objects is
 * logged for a manual cleanup. */
const MAX_OBJECTS_PER_WORKSPACE = 100_000;

function refuse(reason: DeleteAccountRefusal): DeleteAccountResult {
  return { ok: false, reason, notice: DELETE_ACCOUNT_NOTICES[reason] };
}

async function hasRunningPack(db: Pick<Db, "execute">, workspaceId: string): Promise<boolean> {
  const result = (await db.execute(
    sql`select 1 from generation_jobs where workspace_id = ${workspaceId}::uuid and ${RUNNING_STATUSES_SQL} limit 1`,
  )) as unknown;
  // postgres-js returns the rows array; other drivers wrap it in { rows }.
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
  return rows.length > 0;
}

export interface DeleteAccountDeps {
  db: Db;
  userId: string;
  /** Null when R2 is not configured: there are no stored objects to delete. */
  storage: TrustStorage | null;
  /** Null when Stripe has no keys. Omitted, it comes from the environment. */
  stripe?: Stripe | null;
  now?: Date;
}

/** Stripe calls during deletion give up after this long and retry once. */
const STRIPE_OPTIONS = { timeout: 15_000, maxNetworkRetries: 1 } as const satisfies Stripe.RequestOptions;

/** True when Stripe will end the subscription on its own: at the period end
 * (the cancel flow) or at a set date (the portal may set cancel_at). */
export function subscriptionIsEnding(subscription: Pick<Stripe.Subscription, "cancel_at_period_end" | "cancel_at">): boolean {
  return subscription.cancel_at_period_end === true || typeof subscription.cancel_at === "number";
}

type SubscriptionCheck = { allowed: true; cancelInStripe: string[] } | { allowed: false };

/**
 * Whether the workspace's subscriptions let the account go, and which Stripe
 * subscriptions to cancel at once after the data is deleted. Only open rows
 * matter. With Stripe configured, each Stripe row is read live: gone or
 * ended does not block, set to end is canceled after deletion, anything
 * else blocks. Without Stripe the stored cancel_at_period_end or the recorded
 * cancel flow pass is the sign the seller set the plan to end.
 */
async function checkSubscriptions(
  db: Db,
  workspaceId: string,
  stripe: Stripe | null,
  now: Date,
): Promise<SubscriptionCheck> {
  const rows = await db.query.subscriptions.findMany({
    columns: { status: true, provider: true, externalId: true, cancelAtPeriodEnd: true },
    where: (t, { eq }) => eq(t.workspaceId, workspaceId),
  });
  const open = rows.filter((s) => isOpenSubscription(s.status));
  const cancelInStripe: string[] = [];
  let recordedCancel: boolean | null = null;
  for (const row of open) {
    const stripeId = row.provider !== "shopify" ? row.externalId : null;
    if (stripe && stripeId) {
      let live: Stripe.Subscription | null;
      try {
        live = await stripe.subscriptions.retrieve(stripeId, {}, STRIPE_OPTIONS);
      } catch (error) {
        if (!isStripeMissingResource(error)) {
          throw error;
        }
        live = null;
      }
      if (!live || TERMINAL_SUBSCRIPTION_STATUSES.has(live.status)) {
        continue;
      }
      if (subscriptionIsEnding(live)) {
        cancelInStripe.push(live.id);
        continue;
      }
      return { allowed: false };
    }
    if (!stripe && stripeId) {
      // The webhook stores Stripe's own cancel_at_period_end on the row.
      if (row.cancelAtPeriodEnd) {
        continue;
      }
      if (recordedCancel === null) {
        const flows = await db.query.cancelFlows.findMany({
          columns: { outcome: true, error: true, stripeApplied: true, effectiveAt: true },
          where: (t, { eq }) => eq(t.workspaceId, workspaceId),
          orderBy: (t, { desc }) => [desc(t.createdAt)],
          limit: 200,
        });
        recordedCancel = cancelStateFromRows(flows, now).pending?.outcome === "canceled";
      }
      if (recordedCancel) {
        continue;
      }
    }
    return { allowed: false };
  }
  return { allowed: true, cancelInStripe };
}

export async function deleteAccountData({
  db,
  userId,
  storage,
  stripe: stripeDep,
  now = new Date(),
}: DeleteAccountDeps): Promise<DeleteAccountResult> {
  if (!userId) {
    return refuse("not_signed_in");
  }
  const stripe = stripeDep === undefined ? (isStripeConfigured() ? getStripe() : null) : stripeDep;
  const memberships = await db.query.members.findMany({ where: (t, { eq }) => eq(t.userId, userId) });

  // Workspaces this user owns: deleted whole when the user is the only
  // member, refused when others would lose their work.
  const owned: string[] = [];
  for (const membership of memberships) {
    if (membership.role !== "owner") {
      continue;
    }
    const others = await db.query.members.findMany({
      columns: { userId: true },
      where: (t, { and, eq, ne }) => and(eq(t.workspaceId, membership.workspaceId), ne(t.userId, userId)),
    });
    if (others.length > 0) {
      return refuse("shared_workspace");
    }
    owned.push(membership.workspaceId);
  }

  const cancelInStripe: string[] = [];
  for (const workspaceId of owned) {
    // An orphaned run left by a restart must not block deletion forever.
    await reconcileStaleJobs(db, { workspaceId });
    if (await hasRunningPack(db, workspaceId)) {
      return refuse("pack_running");
    }
    const check = await checkSubscriptions(db, workspaceId, stripe, now);
    if (!check.allowed) {
      return refuse("subscription_open");
    }
    cancelInStripe.push(...check.cancelInStripe);
  }

  try {
    await db.transaction(async (tx) => {
      for (const workspaceId of owned) {
        await tx.execute(sql`select 1 from workspaces where id = ${workspaceId}::uuid for update`);
        if (await hasRunningPack(tx, workspaceId)) {
          // Rolls back every workspace deleted so far in this transaction.
          throw new PackStartedError();
        }
        await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));
      }
      // Seats in workspaces the user does not own go; the workspace stays.
      await tx.delete(members).where(eq(members.userId, userId));
      await tx.delete(termsAcceptances).where(eq(termsAcceptances.userId, userId));
    });
  } catch (err) {
    if (err instanceof PackStartedError) {
      return refuse("pack_running");
    }
    throw err;
  }

  // The seller already set these to end; end them now so nothing is left
  // running in Stripe for a workspace that is gone. A failure is logged
  // only: the subscription still ends on its own at the date it was set to.
  if (stripe) {
    for (const subscriptionId of cancelInStripe) {
      try {
        await stripe.subscriptions.cancel(
          subscriptionId,
          { prorate: false, invoice_now: false, cancellation_details: { comment: "Account deleted" } },
          STRIPE_OPTIONS,
        );
      } catch (err) {
        if (!isStripeMissingResource(err)) {
          console.error(
            `[account] could not cancel Stripe subscription ${subscriptionId} for deleted user ${userId}; it still ends at the date it was set to`,
            err,
          );
        }
      }
    }
  }

  let objectsDeleted = 0;
  let objectsFailed = 0;
  if (storage) {
    for (const workspaceId of owned) {
      const prefix = `ws/${workspaceId}/`;
      try {
        const objects = await storage.list(prefix, MAX_OBJECTS_PER_WORKSPACE);
        const failed = await storage.deleteMany(objects.map((o) => o.key));
        objectsDeleted += objects.length - failed.length;
        objectsFailed += failed.length;
        if (failed.length > 0 || objects.length >= MAX_OBJECTS_PER_WORKSPACE) {
          console.error(
            `[account] ${failed.length} objects under ${prefix} were not deleted for deleted user ${userId}; delete the prefix by hand`,
          );
        }
      } catch (err) {
        objectsFailed += 1;
        console.error(`[account] could not clean ${prefix} for deleted user ${userId}; delete the prefix by hand`, err);
      }
    }
  }
  return { ok: true, workspacesDeleted: owned, objectsDeleted, objectsFailed };
}

class PackStartedError extends Error {
  constructor() {
    super("a pack started while the account was being deleted");
    this.name = "PackStartedError";
  }
}
