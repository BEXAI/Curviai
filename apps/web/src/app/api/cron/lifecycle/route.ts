/**
 * POST /api/cron/lifecycle (docs/phases/PHASE_18.md P18-06 and P18-07)
 * One lifecycle email run (packages/email/src/run.ts): reads the funnel,
 * jobs, ledger, leads and the send log, picks the emails due now
 * (dueEmails) and sends them through Resend inside the seeded per run and
 * per UTC day caps. Joins the existing stale-jobs cron command (every 10 to
 * 15 minutes), so no new Render cron service and never Trigger.dev.
 *
 * Protected by CRON_SECRET (Authorization: Bearer, or x-cron-secret): 503
 * while the secret is unset, 401 for a wrong or missing one. Nothing is
 * sent while platform_settings ops:lifecycle_email_enabled is false (default
 * false) or the sender variables are unset; the answer says which.
 * ?dryRun=1 lists what is due by template without sending or writing,
 * whatever the switch. The acquisition gate (P18-03) holds the nudges and
 * offers while packs are paused. The answer carries counts and variable
 * names only, never an address. Demo mode answers 200 with skipped.
 */

import { NextResponse } from "next/server";
import { packFidelitySummary } from "@curvi/db";
import { runLifecycle } from "@curvi/email";
import { acquisitionStatus } from "@/lib/acquisition";
import { checkCronAuth } from "@/lib/cron-auth";
import { recordCronSuccess } from "@/lib/cron-health";
import { lifecycleEmailConfig } from "@/lib/email/config";
import { feedbackLinkPath } from "@/lib/feedback/link";
import { CREDIT_TERMS_SENTENCE, typicalPackCredits } from "@/lib/marketing-facts";
import { opsEmails } from "@/lib/ops";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function POST(request: Request): Promise<NextResponse> {
  const auth = checkCronAuth(request.headers);
  if (auth === "unconfigured") {
    return NextResponse.json({ error: "This job is not configured on this server." }, { status: 503, headers: NO_STORE });
  }
  if (auth === "denied") {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
  }
  if (!isDbMode()) {
    return NextResponse.json({ ok: true, skipped: "The database is not configured." }, { headers: NO_STORE });
  }
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  try {
    const db = getDb();
    const gate = await acquisitionStatus();
    const report = await runLifecycle({
      db,
      config: lifecycleEmailConfig(),
      acquisitionOpen: gate.state === "open",
      typicalPackCredits: typicalPackCredits(),
      // P20-05: the out of credits email states the one credit terms sentence.
      creditTerms: CREDIT_TERMS_SENTENCE,
      feedbackLink: ({ jobId, userId, now }) => feedbackLinkPath({ jobId, userId }, { now }),
      // P18-08: the pack ready email quotes the measured product check.
      fidelity: async ({ jobId, workspaceId }) => {
        const summary = await packFidelitySummary(db, { jobId, workspaceId });
        return summary.measuredFiles > 0 && summary.highestMeanDeltaE !== null
          ? { highestMean: summary.highestMeanDeltaE, allWithinLimits: summary.allWithinLimits }
          : null;
      },
      // Operator workspaces (prospect and test packs) get no lifecycle email.
      excludeOwnerEmails: opsEmails(),
      dryRun,
    });
    const counts = Object.values(report.byTemplate);
    const failed = counts.reduce((total, row) => total + (row.failed ?? 0) + (row.invalid ?? 0), 0);
    if (failed > 0) {
      // Preserve the previous success marker so the next tick retries. The
      // durable send log keeps already delivered emails from being resent.
      return NextResponse.json({ ok: false, ...report, failed }, { status: 503, headers: NO_STORE });
    }
    const skipped = dryRun || report.status !== "ran" ? report.status
      : report.stoppedBy ?? (counts.some((row) => (row.disabled ?? 0) + (row.waiting ?? 0) > 0) ? "waiting_configuration" : null);
    if (skipped) return NextResponse.json({ ok: true, ...report, failed, skipped }, { headers: NO_STORE });
    await recordCronSuccess(db, "lifecycle");
    return NextResponse.json({ ok: true, ...report, failed }, { headers: NO_STORE });
  } catch (err) {
    console.error("[lifecycle] the email run failed", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "The lifecycle email run failed. Check the server log." }, { status: 500, headers: NO_STORE });
  }
}
