/**
 * POST /api/cron/stale-jobs
 * The scheduled stale job sweep: fails every job that has not moved within
 * the stale window, across all workspaces, and releases the credits it still
 * holds (lib/services/reconcile.ts). Protected by CRON_SECRET (lib/cron-auth);
 * run it every 10 minutes or so. In demo mode there is nothing to sweep.
 */

import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { recordCronSuccess } from "@/lib/cron-health";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { sweepStaleJobs } from "@/lib/services/reconcile";

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
  if (!isDbMode()) {
    return NextResponse.json({ ok: true, mode: "demo", reconciled: 0 }, { headers: NO_STORE });
  }
  try {
    const db = getDb();
    const result = await sweepStaleJobs(db);
    if (result.releaseFailures.length === 0) {
      // Health warns when this goes stale (lib/cron-health.ts).
      await recordCronSuccess(db, "stale-jobs");
    }
    if (result.reconciled.length > 0) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "stale_jobs_swept",
          reconciled: result.reconciled.length,
          releaseFailures: result.releaseFailures.length,
        }),
      );
    }
    return NextResponse.json(
      {
        ok: result.releaseFailures.length === 0,
        mode: "db",
        reconciled: result.reconciled.length,
        jobIds: result.reconciled.map((job) => job.id),
        releaseFailures: result.releaseFailures,
      },
      { status: result.releaseFailures.length === 0 ? 200 : 500, headers: NO_STORE },
    );
  } catch (err) {
    console.error("[cron] stale job sweep failed", err);
    return NextResponse.json({ error: "The sweep could not reach the database." }, { status: 500, headers: NO_STORE });
  }
}
