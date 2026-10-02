/**
 * POST /api/cron/funnel-digest (docs/phases/PHASE_18.md P18-02)
 * The weekly funnel email to the founder (lib/funnel-digest.ts), sent
 * through Resend to FOUNDER_ALERT_EMAIL. Called by the existing daily
 * purge-source-media cron command, so no new cron service is needed: it
 * sends once per ISO week, on the first call on or after Monday 13:00 UTC,
 * and answers every other call with not_due or already_sent.
 *
 * Protected by CRON_SECRET (Authorization: Bearer, or x-cron-secret): 503
 * while the secret is unset, 401 for a wrong or missing one. ?dryRun=1
 * composes this week's email and returns it without sending or claiming
 * the week. Needs the database; without it the answer is 200 with skipped.
 * Without RESEND_API_KEY and FOUNDER_ALERT_EMAIL the email is not sent, the
 * week stays open and the answer is 200 with skipped, so the next call
 * tries again once they are set.
 */

import { NextResponse } from "next/server";
import { sendFounderEmail } from "@curvi/trigger/spend-alerts";
import { checkCronAuth } from "@/lib/cron-auth";
import { recordCronSuccess } from "@/lib/cron-health";
import { optionalEnv } from "@/lib/env";
import { runFunnelDigest } from "@/lib/funnel-digest";
import { opsEmails } from "@/lib/ops";
import { DbMetricsReader, weeklyMetricLines } from "@/lib/ops/weekly-report";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const auth = checkCronAuth(request.headers);
  if (auth === "unconfigured") {
    return NextResponse.json({ error: "This job is not configured on this server." }, { status: 503 });
  }
  if (auth === "denied") {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!isDbMode()) {
    return NextResponse.json({ ok: true, skipped: "The database is not configured." });
  }
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  if (!dryRun && (!optionalEnv("RESEND_API_KEY") || !optionalEnv("FOUNDER_ALERT_EMAIL"))) {
    return NextResponse.json({
      ok: true,
      skipped: "Set RESEND_API_KEY and FOUNDER_ALERT_EMAIL to send the weekly funnel email.",
    });
  }
  try {
    const db = getDb();
    const outcome = await runFunnelDigest(db, {
      dryRun,
      operatorEmails: opsEmails(),
      send: (email) => sendFounderEmail(email),
      extraSections: async () => weeklyMetricLines(await new DbMetricsReader(db).read()),
    });
    if (outcome.status === "send_failed") {
      console.error(JSON.stringify({ msg: "funnel digest: the email was not sent", week: outcome.week, notice: outcome.notice }));
      return NextResponse.json(
        { error: "The weekly funnel email was not sent. Check the server log.", week: outcome.week },
        { status: 502 },
      );
    }
    if (outcome.status === "dry_run") {
      return NextResponse.json({ ok: true, dryRun: true, week: outcome.week, subject: outcome.email.subject, text: outcome.email.text });
    }
    // Health warns when this goes stale (lib/cron-health.ts).
    await recordCronSuccess(db, "funnel-digest");
    return NextResponse.json({ ok: true, ...outcome });
  } catch (err) {
    console.error("[funnel-digest] failed", err);
    return NextResponse.json({ error: "The funnel digest failed. Check the server log." }, { status: 500 });
  }
}
