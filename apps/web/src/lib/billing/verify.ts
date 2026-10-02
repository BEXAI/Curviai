/**
 * What `pnpm billing:verify --workspace <id>` prints (docs/phases/
 * PHASE_20.md P20-03): a workspace's plan, its subscription rows, the
 * ledger by reason, the balance, the last billing events, the renewal
 * consent rows and the plan emails sent (P20-07; law and copy review 19),
 * so the test mode run of docs/STRIPE_SETUP.md section 8 is checked by a
 * script rather than by reading tables by hand. Read only.
 *
 * The plan email claims (billing:email:<kind>:<invoice id>) have no
 * workspace, so they outlive an account deletion; they are found through
 * the invoice ids of the workspace's own grant and debit claims.
 */

import { billingConsents, creditLedger, desc, eq, events, sql, subscriptions, workspaces, type Db } from "@curvi/db";

export const VERIFY_EVENT_LIMIT = 10;

export interface BillingVerification {
  workspace: { id: string; name: string; plan: string; stripeCustomerId: string | null };
  subscriptions: Array<{
    externalId: string | null;
    tier: string | null;
    status: string | null;
    cadence: string | null;
    periodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  }>;
  consents: Array<{
    acceptedAt: string;
    /** The Checkout Session, or the portal session of a plan change. */
    session: string;
    tier: string;
    cadence: string;
    disclosureVersion: string;
    disclosureSha256: string;
    hasText: boolean;
  }>;
  /** Plan emails sent for the workspace's invoices. */
  emails: Array<{ at: string; name: string }>;
  ledgerByReason: Array<{ reason: string; rows: number; credits: number }>;
  balance: number;
  recentEvents: Array<{ at: string; name: string; summary: string }>;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function summary(props: unknown): string {
  const p = (props ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["kind", "reason", "credits", "clawedBack", "restored", "debited", "from", "to", "status"]) {
    const value = p[key];
    if (typeof value === "string" || typeof value === "number") {
      parts.push(`${key} ${value}`);
    }
  }
  return parts.join(", ");
}

/** Reads everything the report shows, or null when no such workspace. */
export async function loadBillingVerification(db: Db, workspaceId: string): Promise<BillingVerification | null> {
  const [workspace] = await db
    .select({ id: workspaces.id, name: workspaces.name, plan: workspaces.plan, stripeCustomerId: workspaces.stripeCustomerId })
    .from(workspaces)
    .where(sql`${workspaces.id}::text = ${workspaceId}`)
    .limit(1);
  if (!workspace) return null;

  const subs = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.workspaceId, workspace.id))
    .orderBy(desc(subscriptions.createdAt));
  const ledger = await db
    .select({
      reason: creditLedger.reason,
      rows: sql<number>`count(*)::int`,
      credits: sql<string>`coalesce(sum(${creditLedger.delta}), 0)::text`,
    })
    .from(creditLedger)
    .where(eq(creditLedger.workspaceId, workspace.id))
    .groupBy(creditLedger.reason)
    .orderBy(creditLedger.reason);
  const recent = await db
    .select({ at: events.at, name: events.name, props: events.props })
    .from(events)
    .where(
      sql`${events.workspaceId} = ${workspace.id}
        and (${events.name} like 'billing:%' or ${events.name} in ('plan_changed', 'billing_duplicate_subscription_refunded'))`,
    )
    .orderBy(desc(events.at))
    .limit(VERIFY_EVENT_LIMIT);

  const consents = await db
    .select()
    .from(billingConsents)
    .where(eq(billingConsents.workspaceId, workspace.id))
    .orderBy(desc(billingConsents.acceptedAt));
  const emailRows = await db
    .select({ at: events.at, name: events.name })
    .from(events)
    .where(
      sql`${events.workspaceId} is null and ${events.name} like 'billing:email:%'
        and split_part(${events.name}, ':', 4) in (
          select substring(claim.name from '^billing:stripe:invoice:(.+)$')
          from events claim
          where claim.workspace_id = ${workspace.id} and claim.name like 'billing:stripe:invoice:%'
        )`,
    )
    .orderBy(desc(events.at))
    .limit(VERIFY_EVENT_LIMIT);

  const ledgerByReason = ledger.map((row) => ({ reason: row.reason, rows: Number(row.rows), credits: round(Number(row.credits)) }));
  return {
    workspace: { ...workspace, stripeCustomerId: workspace.stripeCustomerId ?? null },
    subscriptions: subs.map((row) => ({
      externalId: row.externalId,
      tier: row.tier,
      status: row.status,
      cadence: row.cadence ?? null,
      periodEnd: row.periodEnd ? row.periodEnd.toISOString() : null,
      cancelAtPeriodEnd: Boolean(row.cancelAtPeriodEnd),
    })),
    consents: consents.map((row) => ({
      acceptedAt: row.acceptedAt.toISOString(),
      session: row.checkoutSessionId ?? row.portalSessionId ?? "no session",
      tier: row.tier,
      cadence: row.cadence,
      disclosureVersion: row.disclosureVersion,
      disclosureSha256: row.disclosureSha256,
      hasText: Boolean(row.disclosureText),
    })),
    emails: emailRows.map((row) => ({ at: row.at.toISOString(), name: row.name })),
    ledgerByReason,
    balance: round(ledgerByReason.reduce((sum, row) => sum + row.credits, 0)),
    recentEvents: recent.map((row) => ({ at: row.at.toISOString(), name: row.name, summary: summary(row.props) })),
  };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** The report as lines for the terminal. */
export function formatBillingVerification(report: BillingVerification): string[] {
  const lines: string[] = [];
  const { workspace } = report;
  lines.push(`Workspace ${workspace.id} (${workspace.name})`);
  lines.push(`Plan: ${workspace.plan}`);
  lines.push(`Stripe customer: ${workspace.stripeCustomerId ?? "none"}`);
  lines.push("");
  lines.push("Subscriptions:");
  if (report.subscriptions.length === 0) {
    lines.push("  none");
  }
  for (const sub of report.subscriptions) {
    lines.push(
      `  ${pad(sub.externalId ?? "no id", 24)} ${pad(sub.tier ?? "no tier", 8)} ${pad(sub.cadence ?? "cadence ?", 9)} ${pad(sub.status ?? "no status", 12)} period ends ${sub.periodEnd ?? "unknown"}${sub.cancelAtPeriodEnd ? ", set to end" : ""}`,
    );
  }
  lines.push("");
  lines.push("Ledger by reason:");
  if (report.ledgerByReason.length === 0) {
    lines.push("  no rows");
  }
  for (const row of report.ledgerByReason) {
    lines.push(`  ${pad(row.reason, 10)} ${pad(`${row.rows} ${row.rows === 1 ? "row" : "rows"}`, 10)} ${row.credits}`);
  }
  lines.push(`Balance: ${report.balance}`);
  lines.push("");
  lines.push(`Last ${VERIFY_EVENT_LIMIT} billing events, newest first:`);
  if (report.recentEvents.length === 0) {
    lines.push("  none");
  }
  for (const event of report.recentEvents) {
    lines.push(`  ${event.at}  ${event.name}${event.summary ? `  (${event.summary})` : ""}`);
  }
  lines.push("");
  lines.push("Renewal consents:");
  if (report.consents.length === 0) {
    lines.push("  none");
  }
  for (const consent of report.consents) {
    lines.push(
      `  ${consent.acceptedAt}  ${consent.session}  ${consent.tier} ${consent.cadence}  version ${consent.disclosureVersion}  sha256 ${consent.disclosureSha256.slice(0, 12)}${consent.hasText ? "" : "  (no text kept)"}`,
    );
  }
  lines.push("");
  lines.push("Plan emails sent:");
  if (report.emails.length === 0) {
    lines.push("  none");
  }
  for (const email of report.emails) {
    lines.push(`  ${email.at}  ${email.name}`);
  }
  return lines;
}
