/**
 * POST /api/cron/backup-report
 * The nightly backup (ops/cron/backup.sh on the curvi-backup Render cron,
 * docs/phases/PHASE_20.md P20-10) reports here after the encrypted file is
 * in R2: its key, size, sha256, row counts and ledger total. The route
 * stores the report as platform_settings `backup:last` and records the
 * cron's success, so GET /api/health warns cron_overdue:backup once the
 * newest backup is older than the seeded maxAgeHours. Protected by
 * CRON_SECRET (lib/cron-auth). In demo mode there is nothing to record.
 *
 * GET /api/cron/backup-report (CRON_SECRET) answers the recorded backup's
 * key, size and sha256, so the restore drill restores that exact file and
 * refuses one whose bytes differ (security review 7: the backup token can
 * write to the bucket, so the bucket alone is not trusted). 404 when none
 * is recorded.
 */

import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { recordCronSuccess } from "@/lib/cron-health";
import { backupReportSchema, readRecordedBackup, readReportBody, recordBackupReport } from "@/lib/ops/backups";
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
  const body = await readReportBody(request, backupReportSchema);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status, headers: NO_STORE });
  }
  if (!isDbMode()) {
    return NextResponse.json({ ok: true, mode: "demo", recorded: false }, { headers: NO_STORE });
  }
  try {
    const db = getDb();
    const recorded = await recordBackupReport(db, body.value);
    // Health warns when this goes stale (lib/cron-health.ts).
    await recordCronSuccess(db, "backup");
    console.info(
      JSON.stringify({
        level: "info",
        event: "backup_recorded",
        key: recorded.key,
        monthlyKey: recorded.monthlyKey,
        bytes: recorded.bytes,
      }),
    );
    return NextResponse.json({ ok: true, mode: "db", recorded: true, key: recorded.key }, { headers: NO_STORE });
  } catch (err) {
    console.error("[cron] backup report could not be stored", err);
    return NextResponse.json({ error: "The report could not be stored." }, { status: 500, headers: NO_STORE });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = checkCronAuth(request.headers);
  if (auth === "unconfigured") {
    return NextResponse.json({ error: "Scheduled jobs are not configured on this server." }, { status: 503, headers: NO_STORE });
  }
  if (auth === "denied") {
    return NextResponse.json({ error: "Not authorized." }, { status: 401, headers: NO_STORE });
  }
  if (!isDbMode()) {
    return NextResponse.json({ error: "No backup is recorded in demo mode." }, { status: 404, headers: NO_STORE });
  }
  try {
    const recorded = await readRecordedBackup(getDb());
    if (!recorded) {
      return NextResponse.json({ error: "No backup is recorded yet." }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json(recorded, { headers: NO_STORE });
  } catch (err) {
    console.error("[cron] recorded backup could not be read", err);
    return NextResponse.json({ error: "The recorded backup could not be read." }, { status: 500, headers: NO_STORE });
  }
}
