import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Supabase auth code exchange. Email confirmation, password recovery and
 * OAuth links land here with a one time code; exchanging it sets the session
 * cookies, then the browser continues to the requested in app page.
 */

/** Only same origin paths, so the redirect can never leave the site. */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return "/app";
  }
  return raw;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get("next"));

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.redirect(new URL("/login", url.origin));
  }
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      const login = new URL("/login", url.origin);
      login.searchParams.set("error", error.message);
      return NextResponse.redirect(login);
    }
  }
  return NextResponse.redirect(new URL(next, url.origin));
}
