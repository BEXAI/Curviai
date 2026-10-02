/**
 * Google sign in through Supabase OAuth (docs/phases/PHASE_18.md P18-13).
 *
 * The "Continue with Google" button shows on /signup and /login only when
 * NEXT_PUBLIC_GOOGLE_AUTH is "1", which the founder sets after enabling the
 * Google provider in the Supabase dashboard (docs/PENDING.md, "Phase 18
 * activation founder steps"). The flag is inlined at build time in the
 * browser, so turning it on or off needs a deploy.
 *
 * The flow is Supabase's PKCE flow: signInWithOAuth sends the browser to
 * Google, Google returns to Supabase, and Supabase returns to
 * /auth/callback with a one time code that the callback exchanges, exactly
 * as for an email confirmation link. Supabase marks a Google account's
 * email confirmed when Google says it is verified, so the 0012 grant pays at
 * once and the callback sends the new account to /welcome
 * (docs/verification.md, "Phase 18 activation").
 */

import type { SignInWithOAuthCredentials } from "@supabase/supabase-js";

/** The button label (CLAUDE.md rule 9). */
export const GOOGLE_SIGN_IN_LABEL = "Continue with Google";

/** True when the Google button should show. */
export function googleSignInEnabled(): boolean {
  return process.env.NEXT_PUBLIC_GOOGLE_AUTH === "1";
}

/** The signInWithOAuth call for Google, returning to redirectTo (an
 * /auth/callback URL from signupCallbackUrl). */
export function googleOAuthCredentials(redirectTo: string): SignInWithOAuthCredentials {
  return { provider: "google", options: { redirectTo } };
}
