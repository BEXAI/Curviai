/**
 * The auth callback's referral step (docs/phases/PHASE_18.md P18-24): a
 * fresh verification whose signup link carried ref records a pending
 * referral, while referrals are on and only with a database. Never throws
 * and never blocks the signup.
 */

import { cleanReferralCode } from "./codes";
import { recordReferralSignup, type ReferralSignupOutcome } from "./service";
import { referralsOn } from "./switch";

export async function recordSignupReferral(
  ref: string | null | undefined,
  userId: string | null,
  log: Pick<Console, "error"> = console,
): Promise<ReferralSignupOutcome | null> {
  const code = cleanReferralCode(ref);
  if (!code || !userId) {
    return null;
  }
  try {
    const { isDbMode } = await import("@/lib/services");
    if (!isDbMode() || !(await referralsOn())) {
      return null;
    }
    const { getDb } = await import("@/lib/services/db");
    return await recordReferralSignup(getDb(), { userId, code });
  } catch (err) {
    log.error(
      JSON.stringify({
        level: "error",
        event: "referral_signup_failed",
        user: userId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}
