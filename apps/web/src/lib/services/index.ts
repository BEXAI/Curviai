/**
 * Service layer entry point. getServices() decides at call time:
 * DATABASE_URL plus Supabase configured means DbService, anything less means
 * the in memory DemoService, so the app works with zero env vars set.
 */

import { isSupabaseConfigured, optionalEnv } from "@/lib/env";
import { startPackRun } from "@/lib/pack-runner";
import { createSupabaseServerClient, getSessionUser } from "@/lib/supabase/server";
import { DemoService, getDemoStore } from "./demo";
import { DbService, getDb } from "./db";
import type { Services } from "./types";

export type { Services } from "./types";
export * from "./types";

export function isDbMode(): boolean {
  return Boolean(optionalEnv("DATABASE_URL")) && isSupabaseConfigured();
}

export function getServices(): Services {
  if (isDbMode()) {
    return new DbService({
      db: getDb(),
      getUserId: async () => (await getSessionUser())?.id ?? null,
      getSupabase: () => createSupabaseServerClient(),
      startRun: startPackRun,
    });
  }
  return new DemoService(getDemoStore());
}
