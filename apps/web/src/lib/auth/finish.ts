/**
 * The steps after a sign in link has been exchanged for a session
 * (docs/phases/PHASE_20.md P20-28): the server side terms record, where the
 * signup came from and funnel.signup_confirmed (P18-01, P18-02), the
 * Registration Completed conversion, and on a fresh verification the free
 * preview and prospect claims (P18-12, P18-04), the pending referral
 * (P18-24) and the welcome redirect with the first run profile, which the
 * way back to the ChatGPT consent page skips (PHASE_19 P19-09). Moved out of
 * app/auth/callback/route.ts, so the email confirm route (P20-28) and the
 * callback (PKCE and Google, P18-13) run the same steps in the same order.
 *
 * Every step is best effort and never blocks the sign in.
 */

import { finishEmailChange } from "@/lib/auth/email-change";
import { registrationConversion, sendAdsConversion } from "@/lib/ads-conversions";
import { claimSignupPreview } from "@/lib/free-preview/deps";
import { claimSignupProspect } from "@/lib/prospects/runtime";
import { recordSignupReferral } from "@/lib/referrals/signup";
import { DEFAULT_NEXT_PATH } from "@/lib/safe-next";
import { isDbMode } from "@/lib/services";
import { recordSignupConfirmed } from "@/lib/services/attribution";
import { getDb } from "@/lib/services/db";
import { readSignupCallback } from "@/lib/signup-callback";
import { recordTermsAcceptanceSafely } from "@/lib/trust/terms";
import { isFreshVerification, skipsWelcome, welcomePath } from "@/lib/verification";

/** The signed in user as the exchange returned it. */
export interface FinishUser {
  id: string;
  email?: string;
  created_at?: string | null;
  email_confirmed_at?: string | null;
  app_metadata?: { provider?: unknown } | null;
  user_metadata?: Record<string, unknown> | null;
}

export interface FinishSignInInput {
  /** The user from the exchange, or null when it returned none. */
  user: FinishUser | null;
  /** The destination already passed through safeNextPath. */
  next: string;
  /** The public site origin (publicOrigin), for the conversion's source URL. */
  origin: string;
  /** The request headers: the IP and user agent of the terms record, and
   * the cookie consent of the conversion. */
  headers: Headers;
  /** The link's query: Google's `attr` (P18-01) and the signup callback's
   * attribution and profile (lib/signup-callback.ts). */
  params: URLSearchParams;
}

/**
 * Runs the post sign in steps and returns the path to redirect to: the
 * welcome page (carrying the destination and the first run profile) for a
 * link that just verified the email, unless `next` skips it; the claimed
 * product's new pack page when a claim landed and `next` is the default;
 * otherwise `next`.
 */
export async function finishSignIn(input: FinishSignInInput): Promise<string> {
  const { user, next, origin, headers, params } = input;
  const userId = user?.id ?? null;
  if (userId && isDbMode()) {
    if (user?.email && user.email_confirmed_at) {
      try { await finishEmailChange(getDb(), { id: user.id, email: user.email, email_confirmed_at: user.email_confirmed_at }); } catch { console.error("email_change_sync_failed"); }
    }
    await recordTermsAcceptanceSafely(getDb(), { userId, source: "signup_callback", headers });
    if (user && isFreshVerification(user)) {
      // Once per user: a second fresh link writes nothing new.
      await recordSignupConfirmed(getDb(), { user, attrParam: params.get("attr") });
    }
  }
  // OpenAI Ads "Registration Completed", only for a new account and only
  // with cookie consent (lib/ads-conversions.ts). Never blocks the sign in.
  const registration = user ? registrationConversion(user, `${origin}/signup`) : null;
  if (registration) {
    await sendAdsConversion(registration, { cookieHeader: headers.get("cookie") });
  }
  // A link that just verified the email goes to the welcome page first,
  // except on the way back to the ChatGPT consent page (PHASE_19 P19-09),
  // whose request expires in minutes.
  if (isFreshVerification(user)) {
    const signup = readSignupCallback(params, user);
    // P18-12: a signup that started from a free preview claims it (the
    // photo and its cutout move into the new workspace), and the welcome
    // page continues to /app/new on that product. Never blocks the signup.
    const preview = await claimSignupPreview(signup.attribution?.preview, userId);
    // P18-04: a signup from a prospect's claim link gets that product and
    // is attributed to the outreach (no extra credits, decision 11).
    const claimed = preview ?? (await claimSignupProspect(signup.attribution?.claim, userId));
    // P18-24: an invite link's code becomes a pending referral (only while
    // referrals are on). Never blocks the signup.
    await recordSignupReferral(signup.attribution?.ref, userId);
    if (!skipsWelcome(next)) {
      const destination = claimed && next === DEFAULT_NEXT_PATH ? `/app/new?product=${claimed.productId}` : next;
      return welcomePath(destination, signup.profile);
    }
  }
  return next;
}
