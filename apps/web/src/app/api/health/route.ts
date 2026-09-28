/**
 * GET /api/health
 * Liveness and readiness in one fast check, used by Render's healthCheckPath
 * and by uptime monitors. 503 when the database fails before this instance
 * has passed a whole check since it started (boot readiness), while the
 * database is behind this build's migrations, and while the instance is
 * draining for shutdown. Once a whole check has passed, a database failure
 * is reported in the body (`ok: false`) with status 200, so Render does not
 * restart a running instance over it; the uptime monitor alerts on the body
 * instead. Demo mode
 * (no database) always reports ok. The response carries no secrets; see
 * lib/service-health.ts. Provider configuration detail stays on
 * /api/health/providers.
 *
 * Never rate limited: Render polls this every few seconds and counts a 429
 * as a failure. It calls no limiter, the middleware matcher does not cover
 * it, and lib/rate-limit.ts exempts it (see RATE_LIMIT_EXEMPT_PATHS).
 */

import { NextResponse } from "next/server";
import { isR2Configured, optionalEnv } from "@/lib/env";
import { DEFAULT_PROVIDER_ENTRIES } from "@/lib/health";
import { currentInlinePackRunner } from "@/lib/jobs/inline-runner";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { sql } from "@curvi/db";
import {
  createHealthCache,
  readLatestAppliedMigration,
  runHealthCheck,
  type HealthCache,
} from "@/lib/service-health";

export const dynamic = "force-dynamic";

const globalScope = globalThis as typeof globalThis & { __curviHealthCache?: HealthCache };

/** One per process, so the boot readiness gate and the schema memory hold
 * across requests and route bundles. */
function healthCache(): HealthCache {
  globalScope.__curviHealthCache ??= createHealthCache();
  return globalScope.__curviHealthCache;
}

/** Configuration a db mode instance needs to deliver packs, as stable codes. */
function configWarnings(): string[] {
  const warnings: string[] = [];
  if (!isR2Configured()) {
    warnings.push("storage_not_configured");
  }
  const configuredKinds = new Set(
    DEFAULT_PROVIDER_ENTRIES.filter((entry) => optionalEnv(entry.envVar)).map((entry) => entry.kind),
  );
  if (!configuredKinds.has("llm")) {
    warnings.push("no_llm_provider");
  }
  if (!configuredKinds.has("image")) {
    warnings.push("no_image_provider");
  }
  return warnings;
}

export async function GET(): Promise<NextResponse> {
  const result = await runHealthCheck({
    mode: isDbMode() ? "db" : "demo",
    pingDatabase: async () => {
      await getDb().execute(sql`select 1`);
    },
    latestAppliedMigration: () => readLatestAppliedMigration(getDb()),
    runnerStats: () => currentInlinePackRunner()?.stats() ?? null,
    configWarnings,
    commit: optionalEnv("RENDER_GIT_COMMIT") ?? null,
    cache: healthCache(),
  });
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
