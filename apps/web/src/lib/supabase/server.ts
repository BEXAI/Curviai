import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cache } from "react";
import { isSupabaseConfigured, optionalEnv } from "@/lib/env";

/**
 * Server side Supabase client bound to the request cookies. Returns null when
 * Supabase is not configured so pages can render a setup notice instead of
 * crashing during local development and e2e runs.
 */
export async function createSupabaseServerClient() {
  if (!isSupabaseConfigured()) {
    return null;
  }
  const cookieStore = await cookies();
  return createServerClient(
    optionalEnv("NEXT_PUBLIC_SUPABASE_URL") as string,
    optionalEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY") as string,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component where cookies are read only.
            // Middleware refreshes the session instead.
          }
        },
      },
    },
  );
}

/**
 * The signed in user, checked with Supabase Auth. Memoized per request with
 * React cache(), so the layout, the page and the services they call share
 * one auth round trip instead of one each.
 */
export const getSessionUser = cache(async () => {
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return null;
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});
