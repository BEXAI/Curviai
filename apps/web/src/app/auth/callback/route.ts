import { NextResponse, type NextRequest } from "next/server";
import { registrationConversion, sendAdsConversion } from "@/lib/ads-conversions";
import { postAuthDestination, postAuthParamsFrom, type AuthErrorCode } from "@/lib/safe-next";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { recordTermsAcceptanceSafely } from "@/lib/trust/terms";
import { isFreshVerification, welcomePath } from "@/lib/verification";

/**
 * Supabase auth code exchange. Email confirmation, password recovery and
 * OAuth links land here with a one time code; exchanging it sets the session
 * cookies, then the browser continues to the requested in app page, or to the
 * billing checkout for a plan picked on the pricing page. The destination
 * always goes through safeNextPath (Update.md 4.3), so it never leaves the
 * site. Errors go back to /login as a fixed code, never as provider text.
 * The signup confirmation is also where the server first records the user's
 * terms acceptance, with its own clock and the request IP (lib/trust/terms.ts).
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = postAuthDestination(postAuthParamsFrom(url.searchParams), url.origin);

  const toLogin = (error: AuthErrorCode) => {
    const login = new URL("/login", url.origin);
    login.searchParams.set("error", error);
    if (next !== "/app") {
      login.searchParams.set("next", next);
    }
    return NextResponse.redirect(login);
  };

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return toLogin("unavailable");
  }
  if (code) {
    let userId: string | null = null;
    let user: { id: string; created_at?: string | null; email_confirmed_at?: string | null } | null = null;
    try {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        return toLogin("link_invalid");
      }
      user = data?.user ?? null;
      userId = user?.id ?? null;
    } catch {
      return toLogin("unavailable");
    }
    if (userId && isDbMode()) {
      await recordTermsAcceptanceSafely(getDb(), { userId, source: "signup_callback", headers: request.headers });
    }
    // OpenAI Ads "Registration Completed", only for a new account and only
    // with cookie consent (lib/ads-conversions.ts). Never blocks the sign in.
    const registration = user ? registrationConversion(user, `${url.origin}/signup`) : null;
    if (registration) {
      await sendAdsConversion(registration, { cookieHeader: request.headers.get("cookie") });
    }
    // A link that just verified the email goes to the welcome page first.
    if (isFreshVerification(user)) {
      return NextResponse.redirect(new URL(welcomePath(next), url.origin));
    }
  }
  return NextResponse.redirect(new URL(next, url.origin));
}
