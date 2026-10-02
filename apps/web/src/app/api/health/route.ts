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
 * `status` is "ok", "degraded" or "down", with the codes behind it in
 * `degradedBy` (docs/phases/PHASE_20.md P20-15, lib/health-status.ts). The
 * warnings that feed it also include `breaker_open:<stage>` when every
 * configured provider of a pipeline stage has an open breaker, and the new
 * pack preflight's verdict (`packs_paused:<cause>`, `scenes_paused`, cached
 * for 15 seconds). A `provider_quota` code is degraded only when it pauses
 * a stage. `ok` and the status code mean what they meant before, so
 * Render's restarts do not change.
 *
 * Configuration drift (lib/config-health.ts) is listed under `warnings` as
 * stable codes: missing storage or provider keys per stage, recipes rows
 * unlike the seed, crons that never ran or are overdue, a bad
 * CURVI_SHOT_CONCURRENCY and memory near the container limit. The public
 * response stays coarse. A request with `Authorization: Bearer
 * <CRON_SECRET>` (compared in constant time, lib/cron-auth.ts) also gets
 * `details`: each warning in plain words, the recipe differences (hashes and
 * model ids, never prompts), key presence per stage, cron run times, shot
 * concurrency, memory, and LLM spend and tokens per provider and recipe for
 * the last 7 days (llmSpend, docs/phases/PHASE_17.md workstream 6). The
 * OpenAI credit expiry shows as `llm_credits_expiring:openai` from the first
 * seeded reminder date. A wrong or missing secret gets the public response,
 * never an error, since Render polls this path without one. Key probes live
 * on /api/health/providers.
 *
 * Each poll may also schedule the deploy restart pickup (P18-23,
 * lib/jobs/enqueue.ts scheduleRestartPickup): throttled per process, run
 * after the response, so the new instance of a deploy claims the packs the
 * old one queued to start again within seconds.
 *
 * Never rate limited: Render polls this every few seconds and counts a 429
 * as a failure. It calls no limiter, the middleware matcher does not cover
 * it, and lib/rate-limit.ts exempts it (see RATE_LIMIT_EXEMPT_PATHS).
 */

import { NextResponse } from "next/server";
import { CircuitBreaker, processBreakerStore } from "@curvi/ai";
import { recipeSeedRows } from "@curvi/pipeline/seed";
import { liveProviderTargets } from "@curvi/trigger/provider-probes";
import {
  CONFIG_READ_TIMEOUT_MS,
  buildConfigReport,
  cachedConfigReport,
  createConfigReportCache,
  type ConfigReport,
  type ConfigReportCache,
} from "@/lib/config-health";
import { checkCronAuth } from "@/lib/cron-auth";
import { clientIpDiagnostics } from "@/lib/http/client-ip";
import { isCheckoutOpen, isR2Configured, optionalEnv } from "@/lib/env";
import { scheduleRestartPickup } from "@/lib/jobs/enqueue";
import { currentInlinePackRunner } from "@/lib/jobs/inline-runner";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { sql } from "@curvi/db";
import { providerPreflightDetail } from "@/lib/provider-preflight";
import {
  createHealthCache,
  preflightWarnings,
  providerQuotaWarnings,
  readLatestAppliedMigration,
  readReleaseHealthDetail,
  runHealthCheck,
  stageBreakerWarnings,
  withTimeout,
  type HealthCache,
  type ReleaseHealthDetail,
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
      includeLlmSpend: fresh,
    }),
  );
}

export async function GET(request: Request): Promise<NextResponse> {
  scheduleRestartPickup();
  const authorized = checkCronAuth(request.headers) === "ok";
  const mode = isDbMode() ? "db" : "demo";
  const seen: { report?: ConfigReport; pausedProviders?: string[] } = {};

  const result = await runHealthCheck({
    mode,
    pingDatabase: async () => {
      await getDb().execute(sql`select 1`);
    },
    latestAppliedMigration: () => readLatestAppliedMigration(getDb()),
    runnerStats: () => currentInlinePackRunner()?.stats() ?? null,
    configWarnings: async ({ database }) => {
      // The config report, the breaker reads and the preflight run at once,
      // so the check stays inside Render's 5 second timeout (security
      // review 5).
      const reportRead = configReport(mode, database === "ok", authorized);
      // P20-15: the new pack preflight's verdict (it may read recent quota
      // events, so it waits for a working database and a short timeout, and
      // never fails this).
      const preflightRead =
        database === "ok"
          ? withTimeout(() => providerPreflightDetail(), CONFIG_READ_TIMEOUT_MS).catch(() => null)
          : Promise.resolve(null);
      // Quota warnings read the live breaker state on every call, outside
      // the cached config report: provider_quota:<name> while a provider's
      // account is out of quota (docs/phases/PHASE_14.md 1.2). P20-15: a
      // stage with every provider's breaker open.
      const targets = liveProviderTargets(optionalEnv);
      const breaker = new CircuitBreaker(processBreakerStore());
      const [report, quota, stages, preflight] = await Promise.all([
        reportRead,
        providerQuotaWarnings(
          targets.map((target) => target.name),
          breaker,
        ),
        stageBreakerWarnings(targets, breaker),
        preflightRead,
      ]);
      seen.report = report;
      seen.pausedProviders = stages.pausedProviders;
      return [
        ...seen.report.warnings.map((warning) => warning.code),
        ...quota,
        ...stages.codes,
        ...(preflight ? preflightWarnings(preflight) : []),
      ];
    },
    // Billing warnings count once checkout is open (P20-01 readiness), and
    // the readiness problems once billing is meant to be live.
    classifyContext: () => ({
      checkoutOpen: isCheckoutOpen(),
      billingLive: seen.report?.billingLive ?? false,
      pausedProviders: seen.pausedProviders,
      retirementInfoCodes: seen.report?.warnings.filter((warning) => warning.code.startsWith("llm_model_retiring:") && warning.severity === "info").map((warning) => warning.code),
    }),
    commit: optionalEnv("RENDER_GIT_COMMIT") ?? null,
    cache: healthCache(),
  });

  let body: typeof result.body & { details?: ConfigReport & { release: ReleaseHealthDetail; network: ReturnType<typeof clientIpDiagnostics> } } = result.body;
  if (authorized) {
    const release = mode === "db" && result.body.checks.database === "ok"
      ? await readReleaseHealthDetail(getDb())
      : { appliedWhen: null, runningPacks: null, checkedAt: new Date().toISOString() };
    body = { ...result.body, details: { ...(seen.report ?? (await configReport(mode, false, true))), release, network: clientIpDiagnostics(request.headers) } };
  }
  return NextResponse.json(body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
