/**
 * POST /api/cron/billing-reconcile (docs/phases/PHASE_20.md P20-02)
 * Replays the handled Stripe events of the last
 * `billingReconcile.lookbackHours` through the webhook's processStripeEvent,
 * so a payment whose webhook never landed still grants its credits exactly
 * once, checks the webhook endpoint, and emails the founder when anything
 * was applied or newly failed (lib/billing/reconcile-run.ts). Replays never
 * move money in Stripe.
 *
 * Protected by CRON_SECRET (Authorization: Bearer, or x-cron-secret): 503
 * while the secret is unset, 401 for a wrong or missing one. ?dryRun=1
 * reports what would be written and writes, emails and records nothing.
 * Demo mode has nothing to reconcile; without a Stripe key there is
 * nothing to read, which still counts as a successful run for the cron
 * freshness check. Until the tick exists (P20-38) the stale-jobs cron
 * command calls this route too (docs/LAUNCH_CHECKLIST.md).
 */

import { NextResponse } from "next/server";
import { sendFounderEmail } from "@curvi/trigger/spend-alerts";
import { buildPriceTable } from "@/lib/billing/price-table";
import { runBillingReconcile } from "@/lib/billing/reconcile-run";
import { createStripeLookup, getStripe } from "@/lib/billing/stripe";
import { checkCronAuth } from "@/lib/cron-auth";
import { recordCronSuccess } from "@/lib/cron-health";
import { hasStripeApiKey, optionalEnv, siteUrl } from "@/lib/env";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function POST(request: Request): Promise<NextResponse> {
  const auth = checkCronAuth(request.headers);
  if (auth === "unconfigured") {
    return NextResponse.json({ error: "Scheduled jobs are not configured on this server." }, { status: 503, headers: NO_STORE });
  }
  if (auth === "denied") {
    return NextResponse.json({ error: "Not authorized." }, { status: 401, headers: NO_STORE });
  }
  if (!isDbMode()) {
    return NextResponse.json({ ok: true, mode: "demo", skipped: "No database to reconcile." }, { headers: NO_STORE });
  }
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  const db = getDb();
  if (!hasStripeApiKey()) {
    if (!dryRun) {
      await recordCronSuccess(db, "billing-reconcile");
    }
    return NextResponse.json({ ok: true, skipped: "Stripe has no key, so there is nothing to reconcile." }, { headers: NO_STORE });
  }
  try {
    const stripe = getStripe();
    const report = await runBillingReconcile({
      db,
      stripe,
      lookup: createStripeLookup(stripe),
      priceTable: buildPriceTable(),
      siteUrl: siteUrl(),
      readEnv: optionalEnv,
      sendEmail: (email) => sendFounderEmail(email),
      dryRun,
    });
    const { result } = report;
    return NextResponse.json(
      {
        ok: result.failed.length === 0,
        dryRun,
        since: report.since,
        scanned: result.scanned,
        applied: result.applied,
        alreadyApplied: result.alreadyApplied,
        ignored: result.ignored,
        acknowledged: result.acknowledged,
        failed: result.failed,
        truncated: result.truncated,
        resumeFrom: result.resumeFrom,
        appliedEvents: result.appliedEvents,
        endpoint: report.endpoint,
        emailed: report.emailed,
        ...(report.wouldWrite ? { wouldWrite: report.wouldWrite } : {}),
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    console.error("[billing] reconcile failed", err);
    return NextResponse.json({ error: "The billing reconcile failed. Check the server log." }, { status: 500, headers: NO_STORE });
  }
}
