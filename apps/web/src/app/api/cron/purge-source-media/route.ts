/**
 * POST /api/cron/purge-source-media
 * Runs the 30 day source media purge (apps/web/src/lib/trust/purge.ts).
 * Protected by CRON_SECRET (Authorization: Bearer, or x-cron-secret): 503
 * while the secret is unset, 403 for a wrong or missing one. ?dryRun=1
 * reports what would be deleted and deletes nothing. Needs the database and
 * R2; without either it answers 200 with skipped, since there is nothing to
 * purge. Scheduling is in docs/LAUNCH_CHECKLIST.md.
 */

import { NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { recordCronSuccess } from "@/lib/cron-health";
import { isR2Configured } from "@/lib/env";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { purgeStaleSourceMedia } from "@/lib/trust/purge";
import { r2TrustStorage } from "@/lib/trust/storage";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const auth = checkCronAuth(request.headers);
  if (auth === "unconfigured") {
    return NextResponse.json({ error: "This job is not configured on this server." }, { status: 503 });
  }
  if (auth === "denied") {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!isDbMode() || !isR2Configured()) {
    return NextResponse.json({ ok: true, skipped: "Database or storage is not configured." });
  }
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  try {
    const db = getDb();
    const report = await purgeStaleSourceMedia({ db, storage: r2TrustStorage(), dryRun });
    console.info("[purge] source media purge finished", report);
    if (!dryRun) {
      // Health warns when this goes stale (lib/cron-health.ts).
      await recordCronSuccess(db, "purge-source-media");
    }
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    console.error("[purge] source media purge failed", err);
    return NextResponse.json({ error: "The purge failed. Check the server log." }, { status: 500 });
  }
}
