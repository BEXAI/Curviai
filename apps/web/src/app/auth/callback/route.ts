import { NextResponse, type NextRequest } from "next/server";
import { postAuthDestination, postAuthParamsFrom, type AuthErrorCode } from "@/lib/safe-next";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Supabase auth code exchange. Email confirmation, password recovery and
 * OAuth links land here with a one time code; exchanging it sets the session
 * cookies, then the browser continues to the requested in app page, or to the
 * billing checkout for a plan picked on the pricing page. The destination
 * always goes through safeNextPath (Update.md 4.3), so it never leaves the
 * site. Errors go back to /login as a fixed code, never as provider text.
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
    try {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        return toLogin("link_invalid");
      }
    } catch {
      return toLogin("unavailable");
    }
  }
  return NextResponse.redirect(new URL(next, url.origin));
}
