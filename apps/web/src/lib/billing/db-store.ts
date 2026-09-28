/**
 * Database backed BillingStore. Activates only in db mode and runs on the
 * owner DATABASE_URL connection, which may change workspaces.plan and
 * stripe_customer_id (migration 0002 lets only service level roles do that).
 *
 * Every write that must happen together happens in one transaction:
 * - A grant claims its dedupe name in the events table (unique index from
 *   migration 0003) and inserts the ledger row in the same transaction, so a
 *   failed ledger insert rolls the claim back and Stripe's retry grants
 *   exactly once (Update.md 1.3).
 * - A subscription change reads the subscription's current state from Stripe
 *   before it opens a transaction, so no pooled connection and no lock waits
 *   on the network. It then takes a transaction scoped advisory lock on the
 *   subscription and a lock on the workspace row, and checks that nobody
 *   wrote the subscription row since the read began (the row's xmin, which
 *   every write changes). If someone did, their state may be newer than the
 *   one just read, so it rolls back, reads Stripe again and tries once more;
 *   after SUBSCRIPTION_SYNC_ATTEMPTS it throws and Stripe redelivers the
 *   event. Otherwise it upserts the row, retires any other active row for
 *   the workspace and sets workspaces.plan (Update.md 1.1 and 1.5). Every
 *   write therefore carries a state read after the write before it, so a
 *   late, older event can never overwrite a newer state.
 * - A clawback (refund, dispute) claims its dedupe name, reads the balance
 *   under the same workspace lock the ledger functions use and never takes it
 *   below zero (Phase 10 decision 3). A won dispute gives back what its
 *   clawback took, under an advisory lock on the dispute.
 * - A plan change debit (downgrade) takes the full credit difference, even
 *   below zero. reserve_credits refuses any hold while the balance is below
 *   what a pack needs, so the debt blocks new packs until a top up or the
 *   next renewal covers it.
 */

import { creditLedger, eq, events, sql, subscriptions, workspaces, type Db } from "@curvi/db";
import { isPaidTierKey } from "./plans";
import { acceptsSubscriptionStatus, keepsPaidPlan, SUPERSEDED_STATUS } from "./subscription-status";
import {
  disputeKey,
  roundCredits,
  UnroutableBillingEventError,
  type BillingNote,
  type BillingStore,
  type ClawbackOutcome,
  type CreditClawback,
  type CreditDebit,
  type CreditGrant,
  type DebitOutcome,
  type RestoreOutcome,
  type SubscriptionState,
  type SubscriptionSyncOutcome,
  type SubscriptionUpdate,
} from "./stripe-webhook";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface GrantRow {
  name: string;
  workspaceId: string | null;
  credits: number;
}

/** How many Stripe reads one subscription sync makes at most when other
 * handlers keep writing the same subscription while it reads. */
export const SUBSCRIPTION_SYNC_ATTEMPTS = 3;

/**
 * The subscription row changed during every Stripe read. The route answers
 * 500 and Stripe redelivers the event later, when the burst has passed.
 */
export class SubscriptionSyncConflictError extends Error {
  readonly retryable = true;

  constructor(externalId: string) {
    super(
      `Subscription ${externalId} changed during each of ${SUBSCRIPTION_SYNC_ATTEMPTS} Stripe reads; Stripe will retry the event.`,
    );
    this.name = "SubscriptionSyncConflictError";
  }
}

/** A subscription row as last written: its workspace and its row version. */
interface SubscriptionVersion {
  workspaceId: string;
  version: string;
}

/** Returned from the write transaction when the row changed during the read. */
const CHANGED_DURING_READ = Symbol("changed during read");

export class DbBillingStore implements BillingStore {
  private readonly requireRouting: boolean;

  constructor(
    private readonly db: Db,
    private readonly eventSource: "stripe" | "shopify" = "stripe",
    options: { requireRouting?: boolean } = {},
  ) {
    // Stripe events always carry a workspace or a linked customer, so an
    // unroutable one is retried. Shopify dual billing has no shop to
    // workspace mapping yet and keeps acknowledging.
    this.requireRouting = options.requireRouting ?? eventSource === "stripe";
  }

  private eventName(key: string): string {
    return `billing:${this.eventSource}:${key}`;
  }

  private async resolveWorkspaceId(workspaceId: string | null, stripeCustomerId: string | null): Promise<string | null> {
    if (workspaceId) {
      return workspaceId;
    }
    if (stripeCustomerId) {
      const workspace = await this.db.query.workspaces.findFirst({
        where: (t, { eq }) => eq(t.stripeCustomerId, stripeCustomerId),
      });
      return workspace?.id ?? null;
    }
    return null;
  }

  private async lockWorkspace(tx: Tx, workspaceId: string): Promise<void> {
    await tx.execute(sql`select 1 from workspaces where id = ${workspaceId} for update`);
  }

  /** Serializes every handler that shares `key` until the transaction ends. */
  private async advisoryLock(tx: Tx, key: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${this.eventName(`lock:${key}`)}))`);
  }

  private async balance(tx: Tx, workspaceId: string): Promise<number> {
    const rows = (await tx.execute(
      sql`select coalesce(sum(delta), 0) as balance from credit_ledger where workspace_id = ${workspaceId}`,
    )) as unknown as Array<{ balance: string | number }> | { rows: Array<{ balance: string | number }> };
    return Number(firstRow(rows)?.balance ?? 0);
  }

  /** Credits reversals took back from a grant and not yet given back. Read
   * from the ledger, which members cannot write: clawbacks are refund rows
   * and dispute restores are grant rows, both tagged with the grant. */
  private async netClawedBack(tx: Tx, workspaceId: string, grantName: string): Promise<number> {
    const rows = (await tx.execute(
      sql`select coalesce(sum(-delta), 0) as net
          from credit_ledger
          where workspace_id = ${workspaceId}
            and reason in ('refund', 'grant')
            and step_key = ${clawbackStepKey(grantName)}`,
    )) as unknown as Array<{ net: string | number }> | { rows: Array<{ net: string | number }> };
    return Number(firstRow(rows)?.net ?? 0);
  }

  async recordGrantOnce(key: string, grant: CreditGrant): Promise<boolean> {
    const workspaceId = await this.resolveWorkspaceId(grant.workspaceId, grant.stripeCustomerId);
    if (!workspaceId && this.requireRouting) {
      throw new UnroutableBillingEventError(
        `No workspace for billing grant ${key} (customer ${grant.stripeCustomerId ?? "none"}).`,
      );
    }
    const expiresAt = grant.expiresMonths
      ? new Date(Date.now() + grant.expiresMonths * 30 * 24 * 60 * 60 * 1000)
      : null;
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(events)
        .values({
          workspaceId,
          name: this.eventName(key),
          props: {
            kind: "grant",
            credits: grant.credits,
            reason: grant.reason,
            stripeCustomerId: grant.stripeCustomerId,
            invoiceId: grant.payment?.invoiceId ?? null,
            paymentIntentId: grant.payment?.paymentIntentId ?? null,
            checkoutSessionId: grant.payment?.checkoutSessionId ?? null,
            ...(grant.detail ? { detail: grant.detail } : {}),
          },
        })
        .onConflictDoNothing()
        .returning({ id: events.id });
      if (inserted.length === 0) {
        // The unique index says this payment was already granted.
        return false;
      }
      if (!workspaceId) {
        // Acknowledged but unroutable (Shopify only): the row keeps the audit trail.
        return true;
      }
      await tx.insert(creditLedger).values({
        workspaceId,
        delta: grant.credits,
        reason: grant.reason,
        source: this.eventSource,
        expiresAt,
      });
      return true;
    });
  }

  async linkCustomer(workspaceId: string, stripeCustomerId: string): Promise<void> {
    await this.db
      .update(workspaces)
      .set({ stripeCustomerId, updatedAt: new Date() })
      .where(eq(workspaces.id, workspaceId));
  }

  /** The subscription row's workspace and version. xmin changes on every
   * write to the row, so an unchanged xmin means nobody wrote it since. */
  private async subscriptionVersion(
    executor: Pick<Tx, "select">,
    externalId: string,
  ): Promise<SubscriptionVersion | null> {
    const [row] = await executor
      .select({ workspaceId: subscriptions.workspaceId, version: sql<string>`xmin::text` })
      .from(subscriptions)
      .where(eq(subscriptions.externalId, externalId))
      .limit(1);
    return row ?? null;
  }

  async upsertSubscription(update: SubscriptionUpdate): Promise<SubscriptionSyncOutcome> {
    let seen = await this.subscriptionVersion(this.db, update.externalId);
    const workspaceId =
      seen?.workspaceId ?? (await this.resolveWorkspaceId(update.workspaceId, update.stripeCustomerId));
    if (!workspaceId) {
      if (this.requireRouting) {
        throw new UnroutableBillingEventError(
          `No workspace for subscription ${update.externalId} (customer ${update.stripeCustomerId ?? "none"}).`,
        );
      }
      return { status: "unrouted" };
    }

    for (let attempt = 1; ; attempt += 1) {
      // Stripe is read with no transaction open, so neither a pooled
      // connection nor a lock waits on the network.
      const fresh = update.refresh ? await update.refresh() : null;
      const incoming: SubscriptionState = fresh ?? {
        tier: update.tier,
        status: update.status,
        periodEnd: update.periodEnd,
      };
      // Without a Stripe read the payload is all there is, and the status
      // rules alone keep an older payload from winning.
      const expected = update.refresh ? (seen?.version ?? null) : undefined;
      const outcome = await this.writeSubscription(update.externalId, workspaceId, incoming, expected);
      if (outcome !== CHANGED_DURING_READ) {
        return outcome;
      }
      if (attempt >= SUBSCRIPTION_SYNC_ATTEMPTS) {
        throw new SubscriptionSyncConflictError(update.externalId);
      }
      seen = await this.subscriptionVersion(this.db, update.externalId);
    }
  }

  /**
   * Writes a subscription state read from Stripe (or the event payload) and
   * sets workspaces.plan. `expected` is the row version seen before the
   * Stripe read began (null when there was no row); if the row has another
   * version under the lock, another handler wrote in between, possibly with
   * a newer state, and nothing is written.
   */
  private async writeSubscription(
    externalId: string,
    workspaceId: string,
    incoming: SubscriptionState,
    expected: string | null | undefined,
  ): Promise<SubscriptionSyncOutcome | typeof CHANGED_DURING_READ> {
    return this.db.transaction(async (tx): Promise<SubscriptionSyncOutcome | typeof CHANGED_DURING_READ> => {
      await this.advisoryLock(tx, `subscription:${externalId}`);
      await this.lockWorkspace(tx, workspaceId);
      // The subscription's metadata can name a workspace deleted with its
      // account (deletion cancels a subscription already set to end, and
      // Stripe then sends customer.subscription.deleted). Nothing is left
      // to update; writing would break the foreign key and fail every retry.
      const [workspace] = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      if (!workspace) {
        console.warn(
          JSON.stringify({ msg: "billing: subscription for a deleted workspace ignored", workspaceId, subscription: externalId }),
        );
        return { status: "unrouted" };
      }
      if (expected !== undefined) {
        const now = await this.subscriptionVersion(tx, externalId);
        if ((now?.version ?? null) !== expected) {
          return CHANGED_DURING_READ;
        }
      }

      const rows = await tx.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId));
      const current = rows.find((row) => row.externalId === externalId);

      if (current && !acceptsSubscriptionStatus(current.status, incoming.status)) {
        console.warn(
          JSON.stringify({
            msg: "billing: older subscription state ignored",
            workspaceId,
            subscription: externalId,
            kept: current.status,
            incoming: incoming.status,
          }),
        );
        return { status: "stale", kept: current.status ?? "unknown", incoming: incoming.status };
      }

      if (incoming.status === "active") {
        // A second active subscription would break the one active row index
        // and fail every retry. Checkout sends existing subscribers to the
        // portal, so this only happens for subscriptions made by hand; the
        // newest one wins and the older row is retired.
        for (const row of rows) {
          if (row.externalId !== externalId && row.status === "active") {
            console.warn(
              JSON.stringify({
                msg: "billing: second active subscription, retiring the older row",
                workspaceId,
                retired: row.externalId,
                active: externalId,
              }),
            );
            await tx
              .update(subscriptions)
              .set({ status: SUPERSEDED_STATUS })
              .where(eq(subscriptions.id, row.id));
            row.status = SUPERSEDED_STATUS;
          }
        }
      }

      const periodEnd = incoming.periodEnd ? new Date(incoming.periodEnd) : (current?.periodEnd ?? null);
      if (current) {
        await tx
          .update(subscriptions)
          .set({
            tier: incoming.tier ?? current.tier,
            status: incoming.status,
            periodEnd,
            // Kept when an event does not say, like the in memory store.
            cancelAtPeriodEnd: incoming.cancelAtPeriodEnd ?? current.cancelAtPeriodEnd,
          })
          .where(eq(subscriptions.id, current.id));
        current.tier = incoming.tier ?? current.tier;
        current.status = incoming.status;
      } else {
        const [inserted] = await tx
          .insert(subscriptions)
          .values({
            workspaceId,
            provider: this.eventSource,
            externalId,
            tier: incoming.tier ?? undefined,
            status: incoming.status,
            periodEnd,
            cancelAtPeriodEnd: incoming.cancelAtPeriodEnd ?? false,
          })
          .returning();
        rows.push(inserted);
      }

      await this.syncPlan(tx, workspaceId, rows, externalId, incoming.status);
      return { status: "applied", subscriptionStatus: incoming.status };
    });
  }

  /**
   * Sets workspaces.plan from the newest subscription that keeps a paid plan,
   * or free when none does. A live subscription on a price the table does not
   * know leaves the plan alone rather than dropping a paying customer to free.
   */
  private async syncPlan(
    tx: Tx,
    workspaceId: string,
    rows: Array<typeof subscriptions.$inferSelect>,
    externalId: string,
    status: string,
  ): Promise<void> {
    const live = rows
      .filter((row) => keepsPaidPlan(row.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const known = live.find((row) => isPaidTierKey(row.tier));
    let nextPlan: string;
    if (known?.tier) {
      nextPlan = known.tier;
    } else if (live.length > 0) {
      console.warn(
        JSON.stringify({
          msg: "billing: live subscription on an unmapped price, plan left unchanged",
          workspaceId,
          subscription: externalId,
        }),
      );
      return;
    } else {
      nextPlan = "free";
    }

    const [workspace] = await tx
      .select({ plan: workspaces.plan })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    if (!workspace || workspace.plan === nextPlan) {
      return;
    }
    await tx
      .update(workspaces)
      .set({ plan: nextPlan, updatedAt: new Date() })
      .where(eq(workspaces.id, workspaceId));
    await tx.insert(events).values({
      workspaceId,
      name: "plan_changed",
      props: {
        from: workspace.plan,
        to: nextPlan,
        provider: this.eventSource,
        subscription: externalId,
        status,
      },
    });
  }

  /**
   * Finds the grant a payment made. Only grant names this store writes are
   * considered, and the largest matching grant wins: events rows are member
   * insertable, so a forged row with a smaller credit count must never be able
   * to shrink a clawback.
   */
  private async findGrant(field: "paymentIntentId" | "invoiceId", value: string): Promise<GrantRow | null> {
    const prefix = `billing:${this.eventSource}:`;
    const rows = await this.db
      .select({ name: events.name, workspaceId: events.workspaceId, props: events.props })
      .from(events)
      .where(
        sql`(${events.name} like ${`${prefix}invoice:%`} or ${events.name} like ${`${prefix}checkout:%`})
          and ${events.props}->>'kind' = 'grant'
          and ${events.props}->>${field} = ${value}`,
      );
    let best: GrantRow | null = null;
    for (const row of rows) {
      const credits = Number((row.props as { credits?: unknown } | null)?.credits ?? 0);
      if (!Number.isFinite(credits)) {
        continue;
      }
      if (!best || credits > best.credits) {
        best = { name: row.name, workspaceId: row.workspaceId, credits };
      }
    }
    return best;
  }

  private async claimed(tx: Tx, name: string): Promise<boolean> {
    const rows = await tx.select({ id: events.id }).from(events).where(eq(events.name, name)).limit(1);
    return rows.length > 0;
  }

  async clawbackOnce(key: string, clawback: CreditClawback): Promise<ClawbackOutcome> {
    let grant = clawback.paymentIntentId ? await this.findGrant("paymentIntentId", clawback.paymentIntentId) : null;
    if (!grant && clawback.resolveInvoiceId) {
      // The Stripe lookup happens before the transaction so no row lock is
      // held across a network call.
      const invoiceId = await clawback.resolveInvoiceId();
      grant = invoiceId ? await this.findGrant("invoiceId", invoiceId) : null;
    }
    if (!grant?.workspaceId) {
      return { status: "no_grant" };
    }
    const workspaceId = grant.workspaceId;
    const grantName = grant.name;
    const grantCredits = grant.credits;
    const share = Number.isFinite(clawback.share) ? Math.min(1, Math.max(0, clawback.share)) : 1;
    const disputeId = clawback.disputeId ?? null;

    return this.db.transaction(async (tx): Promise<ClawbackOutcome> => {
      if (disputeId) {
        await this.advisoryLock(tx, disputeKey(disputeId));
        if (await this.claimed(tx, this.eventName(`restore:${disputeKey(disputeId)}`))) {
          // The dispute was won before this withdrawal was processed.
          const skipped = await tx
            .insert(events)
            .values({
              workspaceId,
              name: this.eventName(`clawback:${key}`),
              props: { kind: "clawback", reason: clawback.reason, grant: grantName, disputeId, skipped: true, clawedBack: 0 },
            })
            .onConflictDoNothing()
            .returning({ id: events.id });
          return skipped.length === 0 ? { status: "duplicate" } : { status: "skipped" };
        }
      }
      await this.lockWorkspace(tx, workspaceId);
      // What earlier refunds or disputes already took back for this grant and
      // did not give back, read from the ledger (members cannot write it).
      const prior = await this.netClawedBack(tx, workspaceId, grantName);
      const balance = await this.balance(tx, workspaceId);

      const targeted = Math.max(0, roundCredits(grantCredits * share - prior));
      const clawedBack = roundCredits(Math.min(targeted, Math.max(0, balance)));

      const inserted = await tx
        .insert(events)
        .values({
          workspaceId,
          name: this.eventName(`clawback:${key}`),
          props: {
            kind: "clawback",
            reason: clawback.reason,
            grant: grantName,
            chargeId: clawback.chargeId,
            paymentIntentId: clawback.paymentIntentId,
            disputeId,
            share,
            targeted,
            clawedBack,
          },
        })
        .onConflictDoNothing()
        .returning({ id: events.id });
      if (inserted.length === 0) {
        return { status: "duplicate" };
      }
      if (clawedBack > 0) {
        await tx.insert(creditLedger).values({
          workspaceId,
          delta: -clawedBack,
          reason: "refund",
          source: this.eventSource,
          stepKey: clawbackStepKey(grantName),
        });
      }
      return { status: "applied", workspaceId, targeted, clawedBack };
    });
  }

  async restoreDisputeOnce(disputeId: string): Promise<RestoreOutcome> {
    const key = disputeKey(disputeId);
    return this.db.transaction(async (tx): Promise<RestoreOutcome> => {
      await this.advisoryLock(tx, key);
      const [clawRow] = await tx
        .select({ workspaceId: events.workspaceId, props: events.props })
        .from(events)
        .where(eq(events.name, this.eventName(`clawback:${key}`)))
        .limit(1);
      const props = (clawRow?.props ?? {}) as { grant?: unknown; clawedBack?: unknown };
      const workspaceId = clawRow?.workspaceId ?? null;
      const grantName = typeof props.grant === "string" ? props.grant : null;
      const clawedBack = Number(props.clawedBack ?? 0);

      let restored = 0;
      if (workspaceId && grantName && Number.isFinite(clawedBack) && clawedBack > 0) {
        await this.lockWorkspace(tx, workspaceId);
        // Never give back more than the ledger shows was taken from this
        // grant and not yet returned, whatever the events row says.
        const net = await this.netClawedBack(tx, workspaceId, grantName);
        restored = roundCredits(Math.min(clawedBack, Math.max(0, net)));
      }

      // Claimed even when there is nothing to give back, so a withdrawal
      // processed after the win is skipped instead of taking credits.
      const inserted = await tx
        .insert(events)
        .values({
          workspaceId,
          name: this.eventName(`restore:${key}`),
          props: { kind: "restore", reason: "dispute_won", disputeId, grant: grantName, restored },
        })
        .onConflictDoNothing()
        .returning({ id: events.id });
      if (inserted.length === 0) {
        return { status: "duplicate" };
      }
      if (!workspaceId || !grantName || restored <= 0) {
        return { status: "nothing_to_restore" };
      }
      await tx.insert(creditLedger).values({
        workspaceId,
        delta: restored,
        reason: "grant",
        source: this.eventSource,
        stepKey: clawbackStepKey(grantName),
      });
      return { status: "applied", workspaceId, restored };
    });
  }

  async debitOnce(key: string, debit: CreditDebit): Promise<DebitOutcome> {
    const workspaceId = await this.resolveWorkspaceId(debit.workspaceId, debit.stripeCustomerId);
    if (!workspaceId) {
      if (this.requireRouting) {
        throw new UnroutableBillingEventError(
          `No workspace for billing debit ${key} (customer ${debit.stripeCustomerId ?? "none"}).`,
        );
      }
      return { status: "duplicate" };
    }
    const debited = roundCredits(debit.credits);
    return this.db.transaction(async (tx): Promise<DebitOutcome> => {
      await this.lockWorkspace(tx, workspaceId);
      const balanceBefore = await this.balance(tx, workspaceId);
      const balanceAfter = roundCredits(balanceBefore - debited);
      const inserted = await tx
        .insert(events)
        .values({
          workspaceId,
          name: this.eventName(key),
          props: {
            kind: "debit",
            credits: debit.credits,
            debited,
            balanceBefore,
            balanceAfter,
            invoiceId: debit.invoiceId,
            stripeCustomerId: debit.stripeCustomerId,
            ...(debit.detail ? { detail: debit.detail } : {}),
          },
        })
        .onConflictDoNothing()
        .returning({ id: events.id });
      if (inserted.length === 0) {
        return { status: "duplicate" };
      }
      if (debited > 0) {
        // In full, even below zero: Stripe returned the money for this time
        // in full, so the credits it paid for go back too.
        await tx.insert(creditLedger).values({
          workspaceId,
          delta: -debited,
          reason: "refund",
          source: this.eventSource,
          stepKey: `plan_change:${debit.invoiceId}`,
        });
      }
      if (balanceAfter < 0) {
        console.warn(
          JSON.stringify({
            msg: "billing: plan change left the balance below zero, new packs wait until it is covered",
            workspaceId,
            invoiceId: debit.invoiceId,
            balanceAfter,
          }),
        );
      }
      return { status: "applied", debited, balanceAfter };
    });
  }

  async noteOnce(eventId: string, note: BillingNote): Promise<void> {
    const workspaceId = await this.resolveWorkspaceId(note.workspaceId, note.stripeCustomerId);
    await this.db
      .insert(events)
      .values({
        workspaceId,
        name: this.eventName(`note:${eventId}`),
        props: { kind: note.kind, stripeCustomerId: note.stripeCustomerId, ...note.props },
      })
      .onConflictDoNothing();
  }
}

/** Ledger step key shared by every reversal of one grant, so a later
 * reversal sees what earlier ones took and gave back. */
function clawbackStepKey(grantName: string): string {
  return `clawback:${grantName}`;
}

/** postgres-js returns rows as an array, PGlite as { rows }. */
function firstRow<T>(result: T[] | { rows: T[] }): T | undefined {
  return Array.isArray(result) ? result[0] : result.rows[0];
}
