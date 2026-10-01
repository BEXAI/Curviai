import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { VISITORS_COPY, VisitorsDashboard, VisitorsNotice } from "@/components/app/visitors-dashboard";
import { isOperator } from "@/lib/ops";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { getSessionUser } from "@/lib/supabase/server";
import { loadVisitorStats, type VisitorStats } from "@/lib/visits/stats";

/**
 * /app/ops/visitors: the cookieless visitor count (lib/visits) for the
 * people listed in OPS_EMAILS. Everyone else, signed in or not, gets a 404,
 * so the page does not exist for them. Never indexed.
 */

export const metadata: Metadata = {
  title: "Site visitors",
  robots: { index: false, follow: false, nocache: true },
};
export const dynamic = "force-dynamic";

async function currentUser() {
  try {
    return await getSessionUser();
  } catch {
    return null;
  }
}

export default async function VisitorsPage() {
  if (!isOperator(await currentUser())) {
    notFound();
  }
  if (!isDbMode()) {
    return <VisitorsNotice message={VISITORS_COPY.needsDatabase} />;
  }
  let stats: VisitorStats;
  try {
    stats = await loadVisitorStats(getDb(), new Date());
  } catch (error) {
    console.error(JSON.stringify({ msg: "ops visitors: stats read failed", error: String(error) }));
    return <VisitorsNotice message={VISITORS_COPY.unavailable} />;
  }
  return <VisitorsDashboard stats={stats} />;
}
