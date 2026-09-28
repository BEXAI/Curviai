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
 * - a Stripe subscription is still open, so nobody keeps getting billed for
 *   a workspace that no longer exists; the seller cancels in Billing first;
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

import { eq, members, sql, termsAcceptances, workspaces, type Db } from "@curvi/db";
import { isOpenSubscription } from "@/lib/billing/subscription-status";
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
}

export async function deleteAccountData({ db, userId, storage }: DeleteAccountDeps): Promise<DeleteAccountResult> {
  if (!userId) {
    return refuse("not_signed_in");
  }
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

  for (const workspaceId of owned) {
    // An orphaned run left by a restart must not block deletion forever.
    await reconcileStaleJobs(db, { workspaceId });
    if (await hasRunningPack(db, workspaceId)) {
      return refuse("pack_running");
    }
    const subscriptions = await db.query.subscriptions.findMany({
      columns: { status: true },
      where: (t, { eq }) => eq(t.workspaceId, workspaceId),
    });
    if (subscriptions.some((s) => isOpenSubscription(s.status))) {
      return refuse("subscription_open");
    }
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
