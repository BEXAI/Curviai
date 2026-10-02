/**
 * Service layer entry point. getServices() decides at call time:
 * DATABASE_URL plus Supabase configured means DbService, anything less means
 * the in memory DemoService, so the app works with zero env vars set in
 * development. In production the demo fallback fails closed: without db
 * mode it throws DemoModeRefusedError unless ALLOW_DEMO_MODE=1 (./demo-mode),
 * so losing an env var never turns every visitor into the owner of one
 * shared workspace. Routes turn that error into a 503 (lib/http/services).
 */

import { isSupabaseConfigured, optionalEnv } from "@/lib/env";
import { createSupabaseServerClient, getSessionUser } from "@/lib/supabase/server";
import { DemoService, getDemoStore } from "./demo";
import { assertDemoModeAllowed } from "./demo-mode";
import { DbService, getDb } from "./db";
import type { Services } from "./types";

export * from "./types";
export { DemoModeRefusedError } from "./demo-mode";

export function isDbMode(): boolean {
  return Boolean(optionalEnv("DATABASE_URL")) && isSupabaseConfigured();
}

export function getServices(): Services {
  if (isDbMode()) {
    return new DbService({
      db: getDb(),
      getUserId: async () => (await getSessionUser())?.id ?? null,
      getUserEmail: async () => (await getSessionUser())?.email ?? null,
      getSupabase: () => createSupabaseServerClient(),
    });
  }
  assertDemoModeAllowed();
  return new DemoService(getDemoStore());
}
