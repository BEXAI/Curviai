/**
 * Removes a Supabase auth user after account deletion. Needs the project's
 * service role key (SUPABASE_SERVICE_ROLE_KEY), which only this server side
 * module reads; auth.admin.deleteUser "requires a service_role key" and must
 * never run in the browser (Supabase JS reference, checked 2026-09-28).
 *
 * Without the key the data is still deleted and the user signed out, but the
 * sign in itself stays until someone removes it in the Supabase dashboard;
 * the log line says which user. Signing in again before then finds an empty
 * account.
 */

import { createClient } from "@supabase/supabase-js";
import { optionalEnv } from "@/lib/env";

export type AuthUserRemoval = "deleted" | "not_configured" | "failed";

export async function deleteAuthUser(userId: string): Promise<AuthUserRemoval> {
  const url = optionalEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = optionalEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    console.warn(`[account] SUPABASE_SERVICE_ROLE_KEY is not set; remove auth user ${userId} in the Supabase dashboard`);
    return "not_configured";
  }
  try {
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) {
      console.error(`[account] could not delete auth user ${userId}; remove it in the Supabase dashboard`, error);
      return "failed";
    }
    return "deleted";
  } catch (err) {
    console.error(`[account] could not delete auth user ${userId}; remove it in the Supabase dashboard`, err);
    return "failed";
  }
}
