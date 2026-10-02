import type { Metadata } from "next";
import { channelChoices, prospectClaims } from "@curvi/pipeline/seed";
import { ProspectsDashboard, ProspectsNotice } from "@/components/app/prospects-dashboard";
import { PROSPECT_PAGE_COPY } from "@/lib/prospects/copy";
import { isDbMode } from "@/lib/services";
import { requireOperator } from "@/lib/ops/access";

/**
 * /app/ops/prospects (docs/phases/PHASE_18.md P18-04): the prospect
 * makeover tool for concierge outreach, for the people listed in OPS_EMAILS
 * (lib/ops.ts, founder decision 15). Everyone else, signed in or not, gets
 * a 404. Never indexed. The list, the form and the outreach kit talk to
 * /api/ops/prospects, which checks the same gate on every call.
 */

export const metadata: Metadata = {
  title: "Prospect packs",
  robots: { index: false, follow: false, nocache: true },
};
export const dynamic = "force-dynamic";

export default async function ProspectsPage() {
  await requireOperator();
  if (!isDbMode()) {
    return <ProspectsNotice message={PROSPECT_PAGE_COPY.needsDatabase} />;
  }
  return (
    <ProspectsDashboard
      channels={channelChoices.map((choice) => ({ value: choice.value, label: choice.label }))}
      defaultChannels={[...prospectClaims.defaultChannels]}
      maxCreditsPerAdd={prospectClaims.maxCreditsPerAdd}
    />
  );
}
