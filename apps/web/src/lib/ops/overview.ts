import { platformSettings, sql, type Db } from "@curvi/db";
import { opsSwitchDefaults, opsViews, recipeSeedRows, type OpsSwitchKey } from "@curvi/pipeline/seed";
import { liveProviderTargets } from "@curvi/trigger/provider-probes";
import { CircuitBreaker, processBreakerStore } from "@curvi/ai";
import { readProviderProbes } from "@curvi/trigger/provider-canary";
import { buildConfigReport } from "@/lib/config-health";
import { isCheckoutOpen, isR2Configured, optionalEnv } from "@/lib/env";
import { opsSwitch } from "@/lib/features";
import { platformSettingReader } from "@/lib/platform-settings";
import { currentInlinePackRunner } from "@/lib/jobs/inline-runner";
import { providerPreflightDetail } from "@/lib/provider-preflight";
import { createHealthCache, preflightWarnings, providerQuotaWarnings, readLatestAppliedMigration, runHealthCheck, stageBreakerWarnings } from "@/lib/service-health";
import { customerWorkspace, operatorWorkspaceIds } from "@/lib/customer-metrics";
import { resolveGlobalHardStop } from "@curvi/trigger/spend-policy";

export function rowsOf<T>(result: unknown): T[] { return (Array.isArray(result) ? result : (result as { rows?: T[] }).rows ?? []) as T[]; }

export async function loadOpsOverview(db: Db, now = new Date()) {
  const excluded = await operatorWorkspaceIds(db);
  const report = await buildConfigReport({ mode: "db", databaseOk: true, db: () => db, readEnv: optionalEnv,
    storageConfigured: isR2Configured(), providerTargets: liveProviderTargets(optionalEnv), seedRecipes: recipeSeedRows, includeLlmSpend: true, now: () => now });
  const breaker = new CircuitBreaker(processBreakerStore());
  const targets = liveProviderTargets(optionalEnv);
  const [quota, stages, preflight] = await Promise.all([providerQuotaWarnings(targets.map((target) => target.name), breaker), stageBreakerWarnings(targets, breaker), providerPreflightDetail()]);
  const health = await runHealthCheck({ mode: "db", pingDatabase: async () => { await db.execute(sql`select 1`); },
    latestAppliedMigration: () => readLatestAppliedMigration(db), runnerStats: () => currentInlinePackRunner()?.stats() ?? null,
    configWarnings: () => [...report.warnings.map((warning) => warning.code), ...quota, ...stages.codes, ...preflightWarnings(preflight)],
    classifyContext: () => ({ checkoutOpen: isCheckoutOpen(), billingLive: report.billingLive, pausedProviders: stages.pausedProviders }),
    commit: optionalEnv("RENDER_GIT_COMMIT") ?? null,
    cache: createHealthCache(),
  });
  const [summaryRows, spendRows, tableRows, alertRows, switches, settings, providers, csp, probes, hardStopMicros] = await Promise.all([
    db.execute(sql`select status, count(*)::int as count,
      percentile_cont(0.5) within group (order by extract(epoch from (finished_at - started_at))) as p50,
      percentile_cont(0.95) within group (order by extract(epoch from (finished_at - started_at))) as p95
      from generation_jobs where ${customerWorkspace(excluded, sql`workspace_id`)} and created_at >= ${new Date(now.getTime() - 86400000)} group by status`),
    db.execute(sql`select total_micros from spend_cap_counters where key = ${`caps:global:${now.toISOString().slice(0, 10)}`}`),
    db.execute(sql`select relname as name, pg_total_relation_size(relid)::bigint as bytes from pg_catalog.pg_statio_user_tables order by pg_total_relation_size(relid) desc limit ${opsViews.overviewRows}`),
    db.execute(sql`select id, rule, subject, count, opened_at from ops_alerts where resolved_at is null order by opened_at desc limit ${opsViews.overviewRows}`),
    Promise.all((Object.keys(opsSwitchDefaults) as OpsSwitchKey[]).map(async (key) => ({ key, kind: opsSwitchDefaults[key].kind,
      value: await opsSwitch(key, platformSettingReader(db)) }))),
    db.select().from(platformSettings).where(sql`${platformSettings.key} ~ '^(cron:|backup:|restore_drill:|probe:|canary:)'`),
    Promise.all(liveProviderTargets(optionalEnv).map(async (target) => ({ name: target.name, stages: target.stages, reason: await breaker.openReason(target.name) }))),
    db.execute(sql`select key,total_micros from spend_cap_counters where key like ${`csp|${now.toISOString().slice(0, 10)}|%`} order by total_micros desc limit ${opsViews.overviewRows}`),
    readProviderProbes(db),
    resolveGlobalHardStop(db),
  ]);
  return { excludedWorkspaces: excluded.length, report, health: health.body, switches, hardStopMicros,
    providers: providers.map((provider) => ({ ...provider, probe: probes.get(provider.name) ?? null })), csp: rowsOf<{ key: string; total_micros: string | number }>(csp),
    packs: rowsOf<{ status: string; count: number; p50: number | null; p95: number | null }>(summaryRows),
    spendMicros: Number(rowsOf<{ total_micros: string | number }>(spendRows)[0]?.total_micros ?? 0),
    tables: rowsOf<{ name: string; bytes: string | number }>(tableRows),
    alerts: rowsOf<{ id: string; rule: string; subject: string; count: number; opened_at: Date }>(alertRows),
    // Only safe monitoring records; do not send arbitrary platform settings to the UI.
    monitoring: settings.filter((row) => /^(cron:|backup:|restore_drill:|probe:|canary:)/.test(row.key)),
  };
}
