import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { optionalEnv } from "@/lib/env";
import { publicOrigin } from "@/lib/http/public-origin";
import { postAuthDestination, postAuthParamsFrom } from "@/lib/safe-next";

/**
 * Refreshes the Supabase session and guards /app routes. The OAuth consent
 * page (/oauth/consent, PHASE_19 P19-09) only gets the session refresh: it
 * shows its own sign in form to a signed out visitor. A signed out visit
 * to /app goes to /login with the full path and query string in next, so a
 * link such as /app/billing?checkout=growth&cadence=annual survives sign in.
 * A signed in visit to /login or /signup goes straight to where the auth
 * form would have sent them (a pricing checkout, a safe next, or /app).
 * When Supabase is not configured, everything passes through so the
 * marketing site and demo mode keep working.
 */
export async function middleware(request: NextRequest) {
  // Overwrite any caller-supplied value. Only the enrollment page may pass
  // the layout at AAL1; its actions independently verify the operator.
  request.headers.set("x-curvi-ops-path", request.nextUrl.pathname);
  const url = optionalEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = optionalEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!url || !anonKey) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // A redirect must carry any session cookies the refresh above just set,
  // or the browser keeps a rotated out refresh token.
  function redirectTo(target: URL): NextResponse {
    const redirect = NextResponse.redirect(target);
    for (const cookie of response.cookies.getAll()) {
      redirect.cookies.set(cookie);
    }
    return redirect;
  }

  const { pathname, search } = request.nextUrl;
  // nextUrl carries the container address behind the proxy (lib/http/public-origin.ts).
  const origin = publicOrigin(request);
  const isApp = pathname === "/app" || pathname.startsWith("/app/");

  if (!user && isApp) {
    const login = new URL("/login", origin);
    login.searchParams.set("next", `${pathname}${search}`);
    return redirectTo(login);
  }

  if (user && (pathname === "/login" || pathname === "/signup")) {
    const destination = postAuthDestination(postAuthParamsFrom(request.nextUrl.searchParams), origin);
    return redirectTo(new URL(destination, origin));
  }

  return response;
}

export const config = {
  matcher: ["/app/:path*", "/login", "/signup", "/oauth/:path*"],
};
