import { describe, expect, it } from "vitest";
import { referralReward } from "@curvi/pipeline/seed";
import { CREDIT_TERMS_SENTENCE, identityClaims, unqualifiedClaims } from "@/lib/marketing-facts";
import { referralCopyTexts, referralOfferText, referralRulesText, referralSummaryText } from "./referral-copy";

// CLAUDE.md rule 9 and the claims guard (PHASE_18 principles 7 and 8) for
// the referral copy (P18-24).
const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u;

describe("referral copy", () => {
  it("is plain spoken: no emojis, arrows or dashes as punctuation", () => {
    for (const text of referralCopyTexts()) {
      expect(text, text).not.toMatch(FORBIDDEN_COPY);
      expect(text.trim()).toBe(text);
    }
  });

  it("claims no coming soon feature or identity, and uses no expiry urgency", () => {
    for (const text of referralCopyTexts()) {
      expect(unqualifiedClaims(text), text).toEqual([]);
      expect(identityClaims(text), text).toEqual([]);
      expect(text).not.toMatch(/before (they|your credits) expire|expire soon|hurry/i);
    }
  });

  it("states the seeded reward, cap, lifetime and refund window", () => {
    const r = referralReward;
    expect(referralOfferText()).toBe(
      `Give ${r.credits} credits, get ${r.credits} credits. When someone you invite makes their first purchase, you both get ${r.credits} credits.`,
    );
    expect(referralRulesText()).toContain(`up to ${r.monthlyCapPerReferrer} invites a month`);
    expect(referralRulesText()).toContain(CREDIT_TERMS_SENTENCE);
    expect(referralRulesText()).toContain(`refunded within ${r.clawbackDays} days`);
    expect(referralSummaryText({ signups: 1, pending: 1, rewarded: 0, rewardedThisMonth: 0 })).toBe(
      "1 seller signed up with your link. 0 have made a purchase.",
    );
  });
});
