/**
 * POST /api/cron/restore-drill-report
 * Retained legacy restore tooling reports a drill that passed every check:
 * which backup, step durations and whether it met the tool's recovery target.
 * The route stores platform_settings `restore_drill:last` and preserves the
 * success record. The drill plan was retired on 2026-10-03; no active health
 * or release requirement is derived from these records. Protected by
 * CRON_SECRET (lib/cron-auth). In demo mode there is nothing to record.
 */

import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { RESTORE_DRILL_RUN, recordCronSuccess } from "@/lib/cron-health";
import { readReportBody, recordRestoreDrillReport, restoreDrillReportSchema } from "@/lib/ops/backups";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = checkCronAuth(request.headers);
  if (auth === "unconfigured") {
    return NextResponse.json({ error: "Scheduled jobs are not configured on this server." }, { status: 503, headers: NO_STORE });
  }
  if (auth === "denied") {
    return NextResponse.json({ error: "Not authorized." }, { status: 401, headers: NO_STORE });
  }
  const body = await readReportBody(request, restoreDrillReportSchema);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status, headers: NO_STORE });
  }
  if (!isDbMode()) {
    return NextResponse.json({ ok: true, mode: "demo", recorded: false }, { headers: NO_STORE });
  }
  try {
    const db = getDb();
    const recorded = await recordRestoreDrillReport(db, body.value);
    // Preserve the legacy success record without a freshness requirement.
    await recordCronSuccess(db, RESTORE_DRILL_RUN);
    console.info(
      JSON.stringify({
        level: "info",
        event: "restore_drill_recorded",
        backupKey: recorded.backupKey,
        durationSeconds: recorded.durationSeconds,
        withinRto: recorded.withinRto,
      }),
    );
    return NextResponse.json({ ok: true, mode: "db", recorded: true }, { headers: NO_STORE });
  } catch (err) {
    console.error("[cron] restore drill report could not be stored", err);
    return NextResponse.json({ error: "The report could not be stored." }, { status: 500, headers: NO_STORE });
  }
}
