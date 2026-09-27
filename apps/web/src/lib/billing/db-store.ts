/**
 * Database backed BillingStore. Activates only in db mode. Grants are
 * idempotent and atomic: the Stripe or Shopify event id is written to the
 * events table under a partial unique index (migration 0003), so a duplicate
 * delivery loses the INSERT ... ON CONFLICT race and never double grants.
 */

import { creditLedger, eq, events, subscriptions, type Db } from "@curvi/db";
import type { BillingStore, CreditGrant, SubscriptionUpdate } from "./stripe-webhook";

export class DbBillingStore implements BillingStore {
  constructor(
    private readonly db: Db,
    private readonly eventSource: "stripe" | "shopify" = "stripe",
  ) {}

  private eventName(eventId: string): string {
    return `billing:${this.eventSource}:${eventId}`;
  }

  private async resolveWorkspaceId(grant: CreditGrant): Promise<string | null> {
    if (grant.workspaceId) {
      return grant.workspaceId;
    }
    if (grant.stripeCustomerId) {
      const workspace = await this.db.query.workspaces.findFirst({
        where: (t, { eq }) => eq(t.stripeCustomerId, grant.stripeCustomerId as string),
      });
      return workspace?.id ?? null;
    }
    return null;
  }

  async recordGrantOnce(eventId: string, grant: CreditGrant): Promise<boolean> {
    const workspaceId = await this.resolveWorkspaceId(grant);
    const inserted = await this.db
      .insert(events)
      .values({
        workspaceId,
        name: this.eventName(eventId),
        props: { credits: grant.credits, reason: grant.reason, stripeCustomerId: grant.stripeCustomerId },
      })
      .onConflictDoNothing()
      .returning({ id: events.id });
    if (inserted.length === 0) {
      // The unique index says this event id was already processed.
      return false;
    }
    if (!workspaceId) {
      // Acknowledged but unroutable: the event row keeps the audit trail.
      return true;
    }
    const expiresAt = grant.expiresMonths
      ? new Date(Date.now() + grant.expiresMonths * 30 * 24 * 60 * 60 * 1000)
      : null;
    await this.db.insert(creditLedger).values({
      workspaceId,
      delta: grant.credits,
      reason: grant.reason,
      source: this.eventSource,
      expiresAt,
    });
    return true;
  }

  async upsertSubscription(update: SubscriptionUpdate): Promise<void> {
    const existing = await this.db.query.subscriptions.findFirst({
      where: (t, { eq }) => eq(t.externalId, update.externalId),
    });
    const workspaceId =
      update.workspaceId ??
      (await this.resolveWorkspaceId({
        workspaceId: null,
        stripeCustomerId: update.stripeCustomerId,
        credits: 0,
        reason: "grant",
        expiresMonths: null,
      }));
    if (!existing) {
      if (!workspaceId) {
        return;
      }
      await this.db.insert(subscriptions).values({
        workspaceId,
        provider: this.eventSource,
        externalId: update.externalId,
        tier: update.tier ?? undefined,
        status: update.status,
        periodEnd: update.periodEnd ? new Date(update.periodEnd) : null,
      });
      return;
    }
    await this.db
      .update(subscriptions)
      .set({
        tier: update.tier ?? existing.tier,
        status: update.status,
        periodEnd: update.periodEnd ? new Date(update.periodEnd) : existing.periodEnd,
      })
      .where(eq(subscriptions.id, existing.id));
  }
}
