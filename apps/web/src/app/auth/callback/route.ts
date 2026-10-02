import { NextResponse, type NextRequest } from "next/server";
import { finishSignIn, type FinishUser } from "@/lib/auth/finish";
import { publicOrigin } from "@/lib/http/public-origin";
import { postAuthDestination, postAuthParamsFrom, type AuthErrorCode } from "@/lib/safe-next";
import { VIA_PARAM } from "@/lib/signup-callback";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Supabase auth code exchange. Email confirmation, password recovery and
 * OAuth links land here with a one time code; exchanging it sets the session
 * cookies, then the browser continues to the requested in app page, or to the
 * billing checkout for a plan picked on the pricing page. The destination
 * always goes through safeNextPath (Update.md 4.3), so it never leaves the
 * site. Errors go back to /login as a fixed code, never as provider text.
 * The signup confirmation is also where the server first records the user's
 * terms acceptance, with its own clock and the request IP (lib/trust/terms.ts),
 * and, on a fresh verification, where the signup came from and the
 * funnel.signup_confirmed step (lib/services/attribution.ts, P18-01, P18-02).
 * Those steps, the claims, the referral and the welcome redirect live in
 * lib/auth/finish.ts, which the email confirm route of docs/phases/PHASE_20.md
 * P20-28 will share.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  // Behind the proxy the request URL carries the container address; redirects use the public one.
  const origin = publicOrigin(request);
  const code = url.searchParams.get("code");
  const next = postAuthDestination(postAuthParamsFrom(url.searchParams), origin);

  const toLogin = (error: AuthErrorCode) => {
    const login = new URL("/login", origin);
    login.searchParams.set("error", error);
    if (next !== "/app") {
      login.searchParams.set("next", next);
    }
    return NextResponse.redirect(login);
  };

  // ?error= with no code: a Google sign in (P18-13) that was refused or
  // canceled, which carries via=google from its redirect, or an email
  // confirmation or reset link that expired or was used already (Supabase's
  // PKCE flow returns those errors in the query too). Provider text is never
  // shown.
  if (!code && url.searchParams.has("error")) {
    return toLogin(url.searchParams.get(VIA_PARAM) === "google" ? "oauth_failed" : "link_invalid");
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return toLogin("unavailable");
  }
  if (code) {
    let user: FinishUser | null = null;
    try {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        return toLogin("link_invalid");
      }
      user = data?.user ?? null;
    } catch {
      return toLogin("unavailable");
    }
    // The terms record, attribution, the conversion, the claims, the
    // referral and the welcome page.
    const destination = await finishSignIn({ user, next, origin, headers: request.headers, params: url.searchParams });
    return NextResponse.redirect(new URL(destination, origin));
  }
  return NextResponse.redirect(new URL(next, origin));
}
