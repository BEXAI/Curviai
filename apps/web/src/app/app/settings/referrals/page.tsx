import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@curvi/ui";
import { ReferralLink } from "@/components/app/referral-link";
import {
  REFERRALS_OWNERS_ONLY,
  REFERRALS_TITLE,
  referralOfferText,
  referralRulesText,
  referralSummaryText,
} from "@/components/app/referral-copy";
import { siteUrl } from "@/lib/env";
import { referralLink } from "@/lib/referrals/codes";
import { issueReferralCode, referralSummary } from "@/lib/referrals/service";
import { referralsOn } from "@/lib/referrals/switch";
import { getServices, isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";

export const metadata: Metadata = { title: "Invite a seller" };
export const dynamic = "force-dynamic";

/**
 * /app/settings/referrals (docs/phases/PHASE_18.md P18-24): the workspace's
 * invite link and what it earned. Owners and admins only; the code is
 * issued the first time one of them opens this page. Answers 404 while
 * ops:referrals_enabled is off (off by default until founder decision 18) and in
 * demo mode.
 */
export default async function ReferralsPage() {
  if (!isDbMode() || !(await referralsOn())) {
    notFound();
  }
  const workspace = await getServices().ensureWorkspace();
  if (!workspace) {
    notFound();
  }
  const canInvite = workspace.role === "owner" || workspace.role === "admin";
  const db = getDb();
  const [issued, summary] = canInvite
    ? await Promise.all([issueReferralCode(db, workspace.id), referralSummary(db, workspace.id)])
    : [null, null];

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <Link href="/app/settings" className="text-sm text-ink-500 underline">
          Settings
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-ink-950">{REFERRALS_TITLE}</h1>
        <p className="mt-1 text-sm text-ink-700" data-testid="referral-offer">
          {referralOfferText()}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{REFERRALS_TITLE}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {issued && summary ? (
            <>
              <ReferralLink link={referralLink(siteUrl(), issued.code)} />
              <p className="text-sm text-ink-700" data-testid="referral-summary">
                {referralSummaryText(summary)}
              </p>
            </>
          ) : (
            <p className="text-sm text-ink-700" data-testid="referral-owners-only">
              {REFERRALS_OWNERS_ONLY}
            </p>
          )}
          <p className="text-xs text-ink-500">{referralRulesText()}</p>
        </CardContent>
      </Card>
    </div>
  );
}
