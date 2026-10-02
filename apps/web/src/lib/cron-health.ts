/**
 * Cron freshness for GET /api/health. Each scheduled route records its last
 * successful run in platform_settings under `cron:<name>:last_success`
 * (a platform table the web database role already writes; no migration),
 * and the health check warns when a cron has never succeeded or its last
 * success is older than twice its interval, which catches a scheduler that
 * was never set up, lost its secret or keeps failing.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { platformSettings, sql, type Db } from "@curvi/db";
import {
  backup as backupPolicy,
  billingReconcile,
  billingNoticePolicy,
  canaryPolicy,
  funnelDigest,
  tick,
  restoreDrill as restoreDrillPolicy,
} from "@curvi/pipeline/seed";
import type { SqlExecutor } from "@/lib/service-health";
import { isR2Configured, optionalEnv } from "@/lib/env";

const tickManagedSuccess = new AsyncLocalStorage<boolean>();
/** Legacy standalone routes share their core run path with the tick, but
 * only the tick may mark success after checking its lease and result. */
export function withTickManagedSuccess<T>(run: () => Promise<T>): Promise<T> {
  return tickManagedSuccess.run(true, run);
}

/** A UTC time of day, "HH:MM". */
export type UtcTimeOfDay = `${number}:${number}`;

/** What a job's run gets from the runner that calls it (the tick, P20-38). */
export interface CronJobContext {
  db: Db;
  now: Date;
  /** The run should stop starting new work after this time. */
  deadline: Date;
  /** Counters from earlier jobs in this same leased run, for alert rules. */
  state?: { reconciledJobs?: number };
}

/**
 * One registered scheduled job (docs/phases/PHASE_20.md P20-38). Today an
 * external cron command calls each job's own route under /api/cron, and
 * this registry drives only the freshness warnings in /api/health. The tick
 * (P20-38, Lane 10 Schedule) runs the jobs that carry `run`, when due by at
 * most one of `every`, `dailyAtUtc` or `weeklyAt`.
 */
export interface CronJobDefinition {
  name: string;
  /** Freshness: the job is overdue once its last success is older than
   * twice this many minutes, unless maxAgeMinutes says otherwise. */
  intervalMinutes: number;
  /** Freshness override: overdue once the last success is older than this
   * many minutes (the backup's seeded maxAgeHours, P20-10). */
  maxAgeMinutes?: number;
  /** Due every this many minutes (the tick). */
  every?: number;
  /** Due once a day at this UTC time (the tick). */
  dailyAtUtc?: UtcTimeOfDay;
  /** Due once a week on this UTC weekday (0 is Sunday) and time (the tick). */
  weeklyAt?: { weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6; atUtc: UtcTimeOfDay };
  /** The work, for jobs the tick runs. Absent while only a route runs it. */
  run?: (ctx: CronJobContext) => Promise<void>;
  /** Optional integrations do not warn before the operator enables them. */
  monitor?: () => boolean;
}

const scheduledRun = (name: string) => async (ctx: CronJobContext): Promise<void> => {
  await (await import("@/app/api/cron/tick/jobs")).runScheduledJob(name, ctx);
};

/**
 * The scheduled jobs and how often they should run. Phase 20 lanes add
 * their entries here (billing-reconcile, backup, provider-canary,
 * renewal-notices), then Lane 10 turns the list into the tick registry.
 */
export const CRON_JOBS = [
  { name: "stale-jobs", intervalMinutes: tick.everyMinutes, every: tick.everyMinutes, run: scheduledRun("stale-jobs") },
  { name: "purge-source-media", intervalMinutes: 24 * 60, every: 24 * 60, run: scheduledRun("purge-source-media") },
  // Phase 18 P18-02: called by the daily purge-source-media command; it
  // records a run every day and sends once per ISO week.
  { name: "funnel-digest", intervalMinutes: 7 * 24 * 60,
    weeklyAt: { weekday: funnelDigest.sendWeekday, atUtc: `${String(funnelDigest.sendHourUtc).padStart(2, "0")}:00` as UtcTimeOfDay }, run: scheduledRun("funnel-digest") },
  // The fal balance probe (PHASE_18 P18-03), on the stale-jobs command.
  { name: "provider-balance", intervalMinutes: tick.everyMinutes, every: tick.everyMinutes, run: scheduledRun("provider-balance") },
  // Lifecycle email (PHASE_18 P18-07), on the stale-jobs command; it records
  // a run whether or not email is switched on.
  { name: "lifecycle", intervalMinutes: tick.everyMinutes, every: tick.everyMinutes, run: scheduledRun("lifecycle") },
  // P20-02: replays missed Stripe events (lib/billing/reconcile.ts).
  {
    name: "billing-reconcile",
    intervalMinutes: billingReconcile.everyMinutes,
    every: billingReconcile.everyMinutes,
    run: scheduledRun("billing-reconcile"),
  },
  { name: "recovery", intervalMinutes: tick.everyMinutes, every: tick.everyMinutes, run: scheduledRun("recovery") },
  { name: "renewal-notices", intervalMinutes: billingNoticePolicy.everyMinutes, every: billingNoticePolicy.everyMinutes, run: scheduledRun("renewal-notices") },
  { name: "retention", intervalMinutes: 24 * 60, every: 24 * 60, run: scheduledRun("retention") },
  { name: "r2-legacy-sweep", intervalMinutes: 24 * 60, every: 24 * 60, run: scheduledRun("r2-legacy-sweep"), monitor: isR2Configured },
  { name: "visit-salts", intervalMinutes: 24 * 60, every: 24 * 60, run: scheduledRun("visit-salts") },
  { name: "ops-alerts", intervalMinutes: tick.everyMinutes, every: tick.everyMinutes, run: scheduledRun("ops-alerts") },
  { name: "upstash-keepalive", intervalMinutes: 24 * 60, every: 24 * 60, run: scheduledRun("upstash-keepalive"), monitor: () => Boolean(optionalEnv("UPSTASH_REDIS_REST_URL") && optionalEnv("UPSTASH_REDIS_REST_TOKEN")) },
  { name: "provider-canary", intervalMinutes: canaryPolicy.keyProbeEveryMinutes, every: canaryPolicy.keyProbeEveryMinutes, run: scheduledRun("provider-canary"), monitor: () => optionalEnv("CURVI_PROVIDER_CANARY_ENABLED") === "1" },
  // P20-10: the curvi-backup Render cron (09:15 UTC) reports through
  // POST /api/cron/backup-report; stale after the seeded maxAgeHours.
  { name: "backup", intervalMinutes: 24 * 60, maxAgeMinutes: backupPolicy.maxAgeHours * 60 },
] as const;

// Every entry must fit the registry type (a type error here otherwise).
// Kept off the list's own lines so entries other branches add still merge.
const REGISTERED: readonly CronJobDefinition[] = CRON_JOBS;
void REGISTERED;

export type CronName = (typeof CRON_JOBS)[number]["name"];

/** The part of a job the freshness check reads. */
export type CronJob = Pick<CronJobDefinition, "name" | "intervalMinutes" | "maxAgeMinutes" | "monitor">;

/**
 * Runs that record their last success the way a cron does but that no
 * scheduler starts, so they are not in CRON_JOBS and never warn
 * cron_never_ran: the founder's restore drill (P20-11), recorded by
 * POST /api/cron/restore-drill-report. restoreDrillWarning turns a stale one
 * into its own code, restore_drill_overdue (info).
 */
export const RESTORE_DRILL_RUN = "restore-drill";

/** Every name recordCronSuccess accepts. */
export type RecordedRunName = CronName | typeof RESTORE_DRILL_RUN;

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Why a registered job is not well formed (an empty list when it is):
 * a positive interval, at most one schedule, and valid times. */
export function cronJobProblems(job: CronJobDefinition): string[] {
  const problems: string[] = [];
  if (!job.name || !/^[a-z0-9-]+$/.test(job.name)) {
    problems.push("name must be lower case letters, digits and hyphens");
  }
  if (!Number.isInteger(job.intervalMinutes) || job.intervalMinutes <= 0) {
    problems.push("intervalMinutes must be a positive whole number");
  }
  if (job.maxAgeMinutes !== undefined && (!Number.isInteger(job.maxAgeMinutes) || job.maxAgeMinutes <= 0)) {
    problems.push("maxAgeMinutes must be a positive whole number");
  }
  const schedules = [job.every !== undefined, job.dailyAtUtc !== undefined, job.weeklyAt !== undefined];
  if (schedules.filter(Boolean).length > 1) {
    problems.push("set at most one of every, dailyAtUtc and weeklyAt");
  }
  if (job.every !== undefined && (!Number.isInteger(job.every) || job.every <= 0)) {
    problems.push("every must be a positive whole number of minutes");
  }
  if (job.dailyAtUtc !== undefined && !TIME_OF_DAY.test(job.dailyAtUtc)) {
    problems.push("dailyAtUtc must be HH:MM");
  }
  if (job.weeklyAt !== undefined && !TIME_OF_DAY.test(job.weeklyAt.atUtc)) {
    problems.push("weeklyAt.atUtc must be HH:MM");
  }
  return problems;
}

const KEY_PREFIX = "cron:";
const KEY_SUFFIX = ":last_success";

export function cronSettingKey(name: string): string {
  return `${KEY_PREFIX}${name}${KEY_SUFFIX}`;
}

/**
 * Records a successful run. Never throws: a failed write is logged and the
 * cron's own response stays as it was, since the work itself succeeded.
 */
export async function recordCronSuccess(
  db: Db,
  name: RecordedRunName,
  at: Date = new Date(),
  logger: Pick<Console, "warn"> = console,
): Promise<void> {
  if (tickManagedSuccess.getStore()) return;
  try {
    await db
      .insert(platformSettings)
      .values({ key: cronSettingKey(name), value: { at: at.toISOString() }, updatedAt: at })
      .onConflictDoUpdate({
        target: platformSettings.key,
        set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
      });
  } catch (err) {
    logger.warn(`[cron] could not record the ${name} run:`, err instanceof Error ? err.message : String(err));
  }
}

/** postgres-js returns the rows as an array, PGlite as { rows }. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    return result as T[];
  }
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}

function atOf(value: unknown): string | null {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  const at = (parsed as { at?: unknown } | null)?.at;
  return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : null;
}

/** Last success per cron name, as ISO strings. */
export async function readCronSuccesses(db: SqlExecutor): Promise<Record<string, string>> {
  const rows = rowsOf<{ key: string; value: unknown }>(
    await db.execute(
      sql`select key, value from platform_settings where key like ${`${KEY_PREFIX}%${KEY_SUFFIX}`}`,
    ),
  );
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (!row.key.startsWith(KEY_PREFIX) || !row.key.endsWith(KEY_SUFFIX)) continue;
    let at: string | null = null;
    try {
      at = atOf(row.value);
    } catch {
      at = null;
    }
    if (at) {
      out[row.key.slice(KEY_PREFIX.length, row.key.length - KEY_SUFFIX.length)] = at;
    }
  }
  return out;
}

export type CronState = "fresh" | "overdue" | "never";

export interface CronStatus {
  name: string;
  intervalMinutes: number;
  lastSuccess: string | null;
  /** Minutes since the last success, rounded down; null when it never ran. */
  ageMinutes: number | null;
  state: CronState;
}

/** A cron is overdue once its last success is older than twice its
 * interval, or than its maxAgeMinutes when it has one. */
export function cronFreshness(
  successes: Record<string, string>,
  now: Date,
  jobs: readonly CronJob[] = CRON_JOBS,
): CronStatus[] {
  return jobs.filter((job) => job.monitor?.() !== false).map((job) => {
    const lastSuccess = successes[job.name] ?? null;
    if (!lastSuccess) {
      return { name: job.name, intervalMinutes: job.intervalMinutes, lastSuccess: null, ageMinutes: null, state: "never" };
    }
    const ageMs = Math.max(0, now.getTime() - Date.parse(lastSuccess));
    const limitMinutes = job.maxAgeMinutes ?? 2 * job.intervalMinutes;
    const state: CronState = ageMs > limitMinutes * 60_000 ? "overdue" : "fresh";
    return {
      name: job.name,
      intervalMinutes: job.intervalMinutes,
      lastSuccess,
      ageMinutes: Math.floor(ageMs / 60_000),
      state,
    };
  });
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * restore_drill_overdue (info, lib/health-status.ts) when no passing restore
 * drill was recorded, or the last one is older than the seeded maxAgeDays
 * (P20-11); null while the last drill is recent. It reads the successes the
 * cron check already loaded, so it costs no extra query.
 */
export function restoreDrillWarning(
  successes: Record<string, string>,
  now: Date,
  maxAgeDays: number = restoreDrillPolicy.maxAgeDays,
): { code: "restore_drill_overdue"; message: string } | null {
  const last = successes[RESTORE_DRILL_RUN];
  if (!last) {
    return {
      code: "restore_drill_overdue",
      message: "No restore drill has been recorded yet. Run pnpm ops:restore-drill (docs/ops/BACKUP_RESTORE.md).",
    };
  }
  const ageMs = Math.max(0, now.getTime() - Date.parse(last));
  if (ageMs <= maxAgeDays * DAY_MS) {
    return null;
  }
  return {
    code: "restore_drill_overdue",
    message: `The last restore drill passed ${Math.floor(ageMs / DAY_MS)} days ago. Run one at least every ${maxAgeDays} days.`,
  };
}
