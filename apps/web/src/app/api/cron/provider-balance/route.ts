/**
 * POST /api/cron/provider-balance
 * The fal balance probe (docs/phases/PHASE_18.md P18-03, founder decision
 * 8). For every seeded fal account whose Admin API key is set
 * (FAL_ADMIN_KEY, optional FAL_ADMIN_KEY_BACKUP) it reads the balance,
 * stores the newest reading, writes a provider_balance events row at most
 * once an hour, and emails the founder below the alert and pause lines
 * (trigger/src/provider-balance.ts). It then works out the acquisition gate
 * afresh, so a pause or a resume is recorded even when nobody visits.
 *
 * Joins the existing stale-jobs cron command (every 10 to 15 minutes), so
 * no new Render cron service. Protected by CRON_SECRET (lib/cron-auth). In
 * demo mode there is nothing to probe. Without an admin key the route still
 * succeeds and reports each account as not probed; /api/health warns
 * fal_admin_key_missing. The answer goes only to the scheduler: balances,
 * never keys.
 */

import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { recordCronSuccess } from "@/lib/cron-health";
import { acquisitionStatus } from "@/lib/acquisition";
import { optionalEnv } from "@/lib/env";
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
  if (!isDbMode()) {
    return NextResponse.json({ ok: true, mode: "demo", accounts: [] }, { headers: NO_STORE });
  }
  try {
    const db = getDb();
    const [{ checkFalBalances, FounderAlerts }, { PgCapStore }] = await Promise.all([
      import("@curvi/trigger/provider-balance"),
      import("@curvi/trigger/cap-store"),
    ]);
    const store = new PgCapStore(db);
    const accounts = await checkFalBalances({
      db,
      dedupe: store,
      alerts: new FounderAlerts({ dedupe: store, readEnv: optionalEnv }),
      readEnv: optionalEnv,
    });
    const gate = await acquisitionStatus({ fresh: true });
    // Health warns when this goes stale (lib/cron-health.ts).
    await recordCronSuccess(db, "provider-balance");
    return NextResponse.json(
      {
        ok: true,
        mode: "db",
        accounts: accounts.map((a) => ({
          provider: a.provider,
          probed: a.probed,
          ok: a.ok,
          status: a.status,
          balanceUsd: a.balanceUsd,
          band: a.band,
          alert: a.alert,
        })),
        acquisition: gate.state,
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    console.error("[cron] provider balance check failed", err);
    return NextResponse.json({ error: "The balance check could not reach the database." }, { status: 500, headers: NO_STORE });
  }
}
