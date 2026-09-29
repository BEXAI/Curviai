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
 * lib/service-health.ts.
 *
 * A provider whose account answered out of quota shows as the warning
 * `provider_quota:<name>` while its breaker stays open (Phase 14 1.2).
 *
 * Configuration drift (lib/config-health.ts) is listed under `warnings` as
 * stable codes: missing storage or provider keys per stage, recipes rows
 * unlike the seed, crons that never ran or are overdue, a bad
 * CURVI_SHOT_CONCURRENCY and memory near the container limit. The public
 * response stays coarse. A request with `Authorization: Bearer
 * <CRON_SECRET>` (compared in constant time, lib/cron-auth.ts) also gets
 * `details`: each warning in plain words, the recipe differences (hashes and
 * model ids, never prompts), key presence per stage, cron run times, shot
 * concurrency and memory. A wrong or missing secret gets the public response,
 * never an error, since Render polls this path without one. Key probes live
 * on /api/health/providers.
 *
 * Never rate limited: Render polls this every few seconds and counts a 429
 * as a failure. It calls no limiter, the middleware matcher does not cover
 * it, and lib/rate-limit.ts exempts it (see RATE_LIMIT_EXEMPT_PATHS).
 */

import { NextResponse } from "next/server";
import { CircuitBreaker, processBreakerStore } from "@curvi/ai";
import { recipeSeedRows } from "@curvi/pipeline/seed";
import { liveProviderTargets } from "@curvi/trigger/provider-probes";
import { buildConfigReport, cachedConfigReport, createConfigReportCache, type ConfigReport, type ConfigReportCache } from "@/lib/config-health";
import { checkCronAuth } from "@/lib/cron-auth";
import { isR2Configured, optionalEnv } from "@/lib/env";
import { currentInlinePackRunner } from "@/lib/jobs/inline-runner";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { sql } from "@curvi/db";
import {
  createHealthCache,
  providerQuotaWarnings,
  readLatestAppliedMigration,
  runHealthCheck,
  type HealthCache,
} from "@/lib/service-health";

export const dynamic = "force-dynamic";

const globalScope = globalThis as typeof globalThis & {
  __curviHealthCache?: HealthCache;
  __curviConfigReportCache?: ConfigReportCache;
};

/** One per process, so the boot readiness gate and the schema memory hold
 * across requests and route bundles. */
function healthCache(): HealthCache {
  globalScope.__curviHealthCache ??= createHealthCache();
  return globalScope.__curviHealthCache;
}

function configReportCache(): ConfigReportCache {
  globalScope.__curviConfigReportCache ??= createConfigReportCache();
  return globalScope.__curviConfigReportCache;
}

function configReport(mode: "demo" | "db", databaseOk: boolean, fresh: boolean): Promise<ConfigReport> {
  return cachedConfigReport(configReportCache(), { databaseOk, fresh }, () =>
    buildConfigReport({
      mode,
      databaseOk,
      db: getDb,
      readEnv: optionalEnv,
      storageConfigured: isR2Configured(),
      providerTargets: liveProviderTargets(optionalEnv),
      seedRecipes: recipeSeedRows,
    }),
  );
}

export async function GET(request: Request): Promise<NextResponse> {
  const authorized = checkCronAuth(request.headers) === "ok";
  const mode = isDbMode() ? "db" : "demo";
  const seen: { report?: ConfigReport } = {};

  const result = await runHealthCheck({
    mode,
    pingDatabase: async () => {
      await getDb().execute(sql`select 1`);
    },
    latestAppliedMigration: () => readLatestAppliedMigration(getDb()),
    runnerStats: () => currentInlinePackRunner()?.stats() ?? null,
    configWarnings: async ({ database }) => {
      seen.report = await configReport(mode, database === "ok", authorized);
      // Quota warnings read the live breaker state on every call, outside
      // the cached config report: provider_quota:<name> while a provider's
      // account is out of quota (docs/phases/PHASE_14.md 1.2).
      const quota = await providerQuotaWarnings(
        liveProviderTargets(optionalEnv).map((target) => target.name),
        new CircuitBreaker(processBreakerStore()),
      );
      return [...seen.report.warnings.map((warning) => warning.code), ...quota];
    },
    commit: optionalEnv("RENDER_GIT_COMMIT") ?? null,
    cache: healthCache(),
  });

  let body: typeof result.body & { details?: ConfigReport } = result.body;
  if (authorized) {
    body = { ...result.body, details: seen.report ?? (await configReport(mode, false, true)) };
  }
  return NextResponse.json(body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
