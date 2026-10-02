/**
 * Copy for referral give and get credits (docs/phases/PHASE_18.md P18-24).
 * Every number is the seed's referralReward (credits.ts); only wording lives
 * here (CLAUDE.md rules 2 and 9). referral-copy.test.ts lints every string.
 */

import { referralReward } from "@curvi/pipeline/seed";
import type { ReferralSummary } from "@/lib/referrals/service";
import { CREDIT_TERMS_SENTENCE } from "@/lib/marketing-facts";

export const REFERRALS_TITLE = "Invite a seller";
export const REFERRAL_LINK_LABEL = "Your invite link";
export const REFERRAL_COPY_LABEL = "Copy link";
export const REFERRAL_COPIED_LABEL = "Copied";
export const REFERRALS_OWNERS_ONLY = "Only owners and admins of this workspace can invite sellers.";
export const REFERRALS_SETTINGS_LINK = "Invite a seller";

/** "Give 50 credits, get 50 credits. When someone you invite makes their
 * first purchase, you both get 50 credits." A plan or a top up both count
 * (founder decision 12: the first payment), so the plan's "starts a paid
 * plan" became "makes their first purchase", the words T-EM-08 uses. */
export function referralOfferText(): string {
  const credits = referralReward.credits;
  return `Give ${credits} credits, get ${credits} credits. When someone you invite makes their first purchase, you both get ${credits} credits.`;
}

/** The rules, from the seed, with the one credit terms sentence
 * (docs/phases/PHASE_20.md P20-05). */
export function referralRulesText(): string {
  const r = referralReward;
  return `Credits are added after their first purchase, for up to ${r.monthlyCapPerReferrer} invites a month. ${CREDIT_TERMS_SENTENCE} If that purchase is refunded within ${r.clawbackDays} days, both rewards are taken back.`;
}

/** "3 sellers signed up with your link. 1 has made a purchase." */
export function referralSummaryText(summary: ReferralSummary): string {
  const signedUp = summary.signups === 1 ? "1 seller signed up" : `${summary.signups} sellers signed up`;
  return `${signedUp} with your link. ${summary.rewarded} ${summary.rewarded === 1 ? "has" : "have"} made a purchase.`;
}

/** Every string this module can produce, for the lint test. */
export function referralCopyTexts(): string[] {
  return [
    REFERRALS_TITLE,
    REFERRAL_LINK_LABEL,
    REFERRAL_COPY_LABEL,
    REFERRAL_COPIED_LABEL,
    REFERRALS_OWNERS_ONLY,
    REFERRALS_SETTINGS_LINK,
    referralOfferText(),
    referralRulesText(),
    referralSummaryText({ signups: 1, pending: 0, rewarded: 0, rewardedThisMonth: 0 }),
    referralSummaryText({ signups: 3, pending: 2, rewarded: 1, rewardedThisMonth: 1 }),
  ];
}
