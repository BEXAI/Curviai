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
 * - A subscription change upserts the subscriptions row, retires any other
 *   active row for the workspace and sets workspaces.plan, under a lock on
 *   the workspace row (Update.md 1.1 and 1.5).
 * - A clawback (refund, dispute) or a plan change debit (downgrade) claims
 *   its dedupe name, reads the balance under the same workspace lock the
 *   ledger functions use and never takes it below zero.
 */

import { creditLedger, eq, events, sql, subscriptions, workspaces, type Db } from "@curvi/db";
import { isPaidTierKey } from "./plans";
import { keepsPaidPlan, SUPERSEDED_STATUS } from "./subscription-status";
import {
  roundCredits,
  UnroutableBillingEventError,
  type BillingNote,
  type BillingStore,
  type ClawbackOutcome,
  type CreditClawback,
  type CreditDebit,
  type CreditGrant,
  type DebitOutcome,
  type SubscriptionUpdate,
} from "./stripe-webhook";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface GrantRow {
  name: string;
  workspaceId: string | null;
  credits: number;
}

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

  async upsertSubscription(update: SubscriptionUpdate): Promise<void> {
    const existing = await this.db.query.subscriptions.findFirst({
      where: (t, { eq }) => eq(t.externalId, update.externalId),
    });
    const workspaceId =
      existing?.workspaceId ?? (await this.resolveWorkspaceId(update.workspaceId, update.stripeCustomerId));
    if (!workspaceId) {
      if (this.requireRouting) {
        throw new UnroutableBillingEventError(
          `No workspace for subscription ${update.externalId} (customer ${update.stripeCustomerId ?? "none"}).`,
        );
      }
      return;
    }

    await this.db.transaction(async (tx) => {
      await this.lockWorkspace(tx, workspaceId);
      const rows = await tx.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId));
      const current = rows.find((row) => row.externalId === update.externalId);

      if (update.status === "active") {
        // A second active subscription would break the one active row index
        // and fail every retry. Checkout sends existing subscribers to the
        // portal, so this only happens for subscriptions made by hand; the
        // newest one wins and the older row is retired.
        for (const row of rows) {
          if (row.externalId !== update.externalId && row.status === "active") {
            console.warn(
              JSON.stringify({
                msg: "billing: second active subscription, retiring the older row",
                workspaceId,
                retired: row.externalId,
                active: update.externalId,
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

      const periodEnd = update.periodEnd ? new Date(update.periodEnd) : (current?.periodEnd ?? null);
      if (current) {
        await tx
          .update(subscriptions)
          .set({ tier: update.tier ?? current.tier, status: update.status, periodEnd })
          .where(eq(subscriptions.id, current.id));
        current.tier = update.tier ?? current.tier;
        current.status = update.status;
      } else {
        const [inserted] = await tx
          .insert(subscriptions)
          .values({
            workspaceId,
            provider: this.eventSource,
            externalId: update.externalId,
            tier: update.tier ?? undefined,
            status: update.status,
            periodEnd,
          })
          .returning();
        rows.push(inserted);
      }

      await this.syncPlan(tx, workspaceId, rows, update);
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
    update: SubscriptionUpdate,
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
          subscription: update.externalId,
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
        subscription: update.externalId,
        status: update.status,
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

  async clawbackOnce(eventId: string, clawback: CreditClawback): Promise<ClawbackOutcome> {
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
    const clawbackStepKey = `clawback:${grantName}`;
    const share = Number.isFinite(clawback.share) ? Math.min(1, Math.max(0, clawback.share)) : 1;

    return this.db.transaction(async (tx): Promise<ClawbackOutcome> => {
      await this.lockWorkspace(tx, workspaceId);
      // What earlier refunds or disputes already took back for this grant,
      // read from the ledger (members cannot write it), tagged by step_key.
      const priorRows = (await tx.execute(
        sql`select coalesce(sum(-delta), 0) as prior
            from credit_ledger
            where workspace_id = ${workspaceId}
              and reason = 'refund'
              and step_key = ${clawbackStepKey}`,
      )) as unknown as Array<{ prior: string | number }> | { rows: Array<{ prior: string | number }> };
      const prior = Number(firstRow(priorRows)?.prior ?? 0);
      const balanceRows = (await tx.execute(
        sql`select coalesce(sum(delta), 0) as balance from credit_ledger where workspace_id = ${workspaceId}`,
      )) as unknown as Array<{ balance: string | number }> | { rows: Array<{ balance: string | number }> };
      const balance = Number(firstRow(balanceRows)?.balance ?? 0);

      const targeted = Math.max(0, roundCredits(grantCredits * share - prior));
      const clawedBack = roundCredits(Math.min(targeted, Math.max(0, balance)));

      const inserted = await tx
        .insert(events)
        .values({
          workspaceId,
          name: this.eventName(`clawback:${eventId}`),
          props: {
            kind: "clawback",
            reason: clawback.reason,
            grant: grantName,
            chargeId: clawback.chargeId,
            paymentIntentId: clawback.paymentIntentId,
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
          stepKey: clawbackStepKey,
        });
      }
      return { status: "applied", workspaceId, targeted, clawedBack };
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
    return this.db.transaction(async (tx): Promise<DebitOutcome> => {
      await this.lockWorkspace(tx, workspaceId);
      const balanceRows = (await tx.execute(
        sql`select coalesce(sum(delta), 0) as balance from credit_ledger where workspace_id = ${workspaceId}`,
      )) as unknown as Array<{ balance: string | number }> | { rows: Array<{ balance: string | number }> };
      const balance = Number(firstRow(balanceRows)?.balance ?? 0);
      const debited = roundCredits(Math.min(debit.credits, Math.max(0, balance)));
      const inserted = await tx
        .insert(events)
        .values({
          workspaceId,
          name: this.eventName(key),
          props: {
            kind: "debit",
            credits: debit.credits,
            debited,
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
        await tx.insert(creditLedger).values({
          workspaceId,
          delta: -debited,
          reason: "refund",
          source: this.eventSource,
          stepKey: `plan_change:${debit.invoiceId}`,
        });
      }
      return { status: "applied", debited };
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

/** postgres-js returns rows as an array, PGlite as { rows }. */
function firstRow<T>(result: T[] | { rows: T[] }): T | undefined {
  return Array.isArray(result) ? result[0] : result.rows[0];
}
