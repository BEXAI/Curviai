import type { Metadata } from "next";
import { VISITORS_COPY, VisitorsDashboard, VisitorsNotice } from "@/components/app/visitors-dashboard";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { requireOperator } from "@/lib/ops/access";
import { visitsHashKey } from "@/lib/visits/key";
import { loadVisitorStats, type VisitorStats } from "@/lib/visits/stats";
import { deleteExpiredVisitSalts } from "@/lib/visits/store";

/**
 * /app/ops/visitors: the cookieless visitor count (lib/visits) for the
 * people listed in OPS_EMAILS (or OPS_EMAIL, lib/ops.ts). Everyone else,
 * signed in or not, gets a 404, so the page does not exist for them. Never
 * indexed. Opening it also deletes salts older than yesterday, the same
 * cleanup the stale-jobs cron runs, in case that cron is not scheduled.
 */

export const metadata: Metadata = {
  title: "Site visitors",
  robots: { index: false, follow: false, nocache: true },
};
export const dynamic = "force-dynamic";

export default async function VisitorsPage() {
  await requireOperator();
  if (!isDbMode()) {
    return <VisitorsNotice message={VISITORS_COPY.needsDatabase} />;
  }
  const db = getDb();
  try {
    await deleteExpiredVisitSalts(db, new Date());
  } catch (error) {
    console.error(JSON.stringify({ msg: "ops visitors: salt cleanup failed", error: String(error) }));
  }
  if (!visitsHashKey()) {
    return <VisitorsNotice message={VISITORS_COPY.needsKey} />;
  }
  let stats: VisitorStats;
  try {
    stats = await loadVisitorStats(db, new Date());
  } catch (error) {
    console.error(JSON.stringify({ msg: "ops visitors: stats read failed", error: String(error) }));
    return <VisitorsNotice message={VISITORS_COPY.unavailable} />;
  }
  return <VisitorsDashboard stats={stats} />;
}
