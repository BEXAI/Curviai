/**
 * One billing reconcile run (docs/phases/PHASE_20.md P20-02), as the cron
 * route POST /api/cron/billing-reconcile runs it: replay the lookback
 * window, check the webhook endpoint, email the founder about anything
 * applied or newly failed, record the run for /api/health and the cron
 * freshness. A dry run only replays against the read only store and
 * returns what it would do: no write, no email, no record.
 */

import { sql, workspaces, type Db } from "@curvi/db";
import { billingReconcile } from "@curvi/pipeline/seed";
import type { SpendAlertEmail } from "@curvi/trigger/spend-alerts";
import { recordCronSuccess } from "@/lib/cron-health";
import { recordStripeReferrals } from "@/lib/referrals/stripe";
import { createActivationSender, dbEmailClaims } from "./billing-email";
import { billingTransactionalSender } from "./transactional-email";
import { DbBillingStore } from "./db-store";
import { recordStripeFunnel } from "./funnel";
import type { PriceTable } from "./price-table";
import {
  checkWebhookEndpoint,
  composeReconcileEmail,
  DryRunBillingStore,
  failuresToReport,
  reconcileStripe,
  type ReconcileResult,
  type ReconcileStripeClient,
} from "./reconcile";
import {
  readBillingSignals,
  recordBillingEmailResult,
  recordReconcileRun,
  type EndpointCheck,
  type ReconcileRunSignal,
} from "./signals";
import type { StripeLookup } from "./stripe-webhook";

export interface ReconcileRunDeps {
  db: Db;
  stripe: ReconcileStripeClient;
  lookup?: StripeLookup;
  priceTable: PriceTable;
  siteUrl: string;
  readEnv: (name: string) => string | undefined;
  /** sendFounderEmail in production; never throws. */
  sendEmail: (email: SpendAlertEmail) => Promise<{ ok: boolean; notice?: string }>;
  now?: Date;
  dryRun?: boolean;
  policy?: { lookbackHours: number; maxEventsPerRun: number };
  logger?: Pick<Console, "warn" | "info">;
}

export interface ReconcileRunReport {
  dryRun: boolean;
  since: string;
  result: ReconcileResult;
  endpoint: EndpointCheck;
  /** What a dry run would have written. */
  wouldWrite?: Array<{ kind: string; key: string; credits?: number }>;
  emailed: boolean;
  emailNotice?: string;
}

/** Whether a workspace row exists; ids that are not uuids never do. */
export function workspaceExistsIn(db: Db): (workspaceId: string) => Promise<boolean> {
  return async (workspaceId) => {
    const rows = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(sql`${workspaces.id}::text = ${workspaceId}`)
      .limit(1);
    return rows.length > 0;
  };
}

export async function runBillingReconcile(deps: ReconcileRunDeps): Promise<ReconcileRunReport> {
  const now = deps.now ?? new Date();
  const policy = deps.policy ?? billingReconcile;
  const logger = deps.logger ?? console;
  const windowStart = new Date(now.getTime() - policy.lookbackHours * 60 * 60_000);
  let lastRun: ReconcileRunSignal | null = null;
  try {
    lastRun = (await readBillingSignals(deps.db)).reconcile;
  } catch (err) {
    logger.warn("[billing] reconcile could not read its last run:", err instanceof Error ? err.message : String(err));
  }
  // A run that hit its cap processed the oldest events of its window; this
  // one carries on from where it stopped, so a busy window never starves
  // its newest (or, before, its oldest) events. The full window comes back
  // once a run gets through it.
  const resumeFrom = lastRun?.truncated && lastRun.resumeFrom ? new Date(lastRun.resumeFrom) : null;
  const since = resumeFrom && resumeFrom > windowStart ? resumeFrom : windowStart;
  const realStore = new DbBillingStore(deps.db, "stripe");
  const dryStore = deps.dryRun ? new DryRunBillingStore(realStore) : null;

  const result = await reconcileStripe({
    stripe: deps.stripe,
    store: dryStore ?? realStore,
    priceTable: deps.priceTable,
    since,
    maxEvents: policy.maxEventsPerRun,
    lookup: deps.lookup,
    activation: deps.dryRun
      ? undefined
      : createActivationSender({
          claims: dbEmailClaims(deps.db),
          readEnv: deps.readEnv,
          siteUrl: deps.siteUrl,
          send: billingTransactionalSender(deps.db, deps.readEnv),
          recordResult: (emailResult) => recordBillingEmailResult(deps.db, emailResult),
        }),
    workspaceExists: workspaceExistsIn(deps.db),
    // The webhook route's PHASE_18 steps (P18-02 funnel, P18-24 referrals),
    // so a payment whose webhook never landed still counts and rewards.
    afterEvent: deps.dryRun
      ? undefined
      : async (event, outcome) => {
          await recordStripeFunnel(deps.db, event, outcome, deps.priceTable);
          const referrals = await recordStripeReferrals(deps.db, event, outcome, deps.priceTable);
          return { failed: referrals.failed };
        },
    logger,
  });

  let endpoint: EndpointCheck;
  try {
    endpoint = await checkWebhookEndpoint(deps.stripe, { siteUrl: deps.siteUrl, readEnv: deps.readEnv });
  } catch (err) {
    endpoint = {
      ok: true,
      problems: [],
      skipped: `The endpoint list failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
    };
  }

  const report: ReconcileRunReport = {
    dryRun: Boolean(deps.dryRun),
    since: since.toISOString(),
    result,
    endpoint,
    emailed: false,
    ...(dryStore ? { wouldWrite: dryStore.writes } : {}),
  };
  if (deps.dryRun) {
    return report;
  }

  const reported: Record<string, string> = lastRun?.reportedFailures ?? {};
  const { fresh, keep } = failuresToReport(result.failed, reported, now, policy.lookbackHours);
  const email = composeReconcileEmail(result, fresh);
  if (email) {
    const sent = await deps.sendEmail(email);
    report.emailed = sent.ok;
    if (sent.ok) {
      for (const failure of fresh) keep[failure.eventId] = now.toISOString();
    } else {
      report.emailNotice = sent.notice;
      logger.warn(JSON.stringify({ msg: "billing reconcile: founder email not sent", notice: sent.notice, subject: email.subject }));
    }
  }
  if (result.applied > 0 || result.failed.length > 0) {
    logger.warn(
      JSON.stringify({
        msg: "billing reconcile: applied or failed events",
        applied: result.appliedEvents.map((event) => event.eventId),
        failed: result.failed.map((failure) => failure.eventId),
      }),
    );
  }

  await recordReconcileRun(deps.db, {
    at: now.toISOString(),
    newestEventAt: result.newestEventAt,
    applied: result.applied,
    failed: result.failed.length,
    endpoint,
    reportedFailures: keep,
    truncated: result.truncated,
    resumeFrom: result.resumeFrom,
  });
  // The tick uses this timestamp to decide what is due. Keep failed or
  // incomplete replays due, while the run signal above preserves their
  // diagnostics and resume point for the next bounded pass.
  if (result.failed.length === 0 && !result.truncated) {
    await recordCronSuccess(deps.db, "billing-reconcile", now);
  }
  return report;
}
