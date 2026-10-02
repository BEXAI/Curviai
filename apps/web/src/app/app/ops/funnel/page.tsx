import type { Metadata } from "next";
import { FUNNEL_COPY, FunnelDashboard, FunnelNotice } from "@/components/app/funnel-dashboard";
import { loadFunnelReport, type FunnelReport } from "@/lib/funnel-report";
import { opsEmails } from "@/lib/ops";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { requireOperator } from "@/lib/ops/access";

/**
 * /app/ops/funnel (docs/phases/PHASE_18.md P18-02): the server side funnel
 * by week and by source, the same counts as the weekly funnel email, for
 * the people listed in OPS_EMAILS (lib/ops.ts). Everyone else, signed in or
 * not, gets a 404. Never indexed.
 */

export const metadata: Metadata = {
  title: "Funnel",
  robots: { index: false, follow: false, nocache: true },
};
export const dynamic = "force-dynamic";

export default async function FunnelPage() {
  await requireOperator();
  if (!isDbMode()) {
    return <FunnelNotice message={FUNNEL_COPY.needsDatabase} />;
  }
  let report: FunnelReport;
  try {
    report = await loadFunnelReport(getDb(), { operatorEmails: opsEmails() });
  } catch (error) {
    console.error(JSON.stringify({ msg: "ops funnel: read failed", error: String(error) }));
    return <FunnelNotice message={FUNNEL_COPY.unavailable} />;
  }
  return <FunnelDashboard report={report} />;
}
