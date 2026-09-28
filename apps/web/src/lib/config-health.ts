/**
 * Configuration drift behind GET /api/health: what this instance would run
 * on compared with what this build expects. Every finding becomes a warning
 * with a short stable code (public) and a plain sentence (detailed report,
 * bearer CRON_SECRET only). Warnings never fail the health check: a restart
 * cannot fix an env value or a table row.
 *
 * Checks:
 * - storage: R2 credentials present;
 * - provider keys per pipeline stage (presence only, from the same targets
 *   the live wiring registers, trigger/src/provider-probes.ts);
 * - recipe drift: active recipes rows against the compiled seed
 *   (lib/recipe-drift.ts);
 * - cron freshness: each scheduled route's last success (lib/cron-health.ts);
 * - CURVI_SHOT_CONCURRENCY, the container memory limit and current RSS.
 *
 * The database reads run only when the database answered, each under its own
 * timeout, and a failed read becomes a warning instead of an error.
 */

import { readFileSync } from "node:fs";
import type { LiveProviderTarget, StageKeyReport } from "@curvi/trigger/provider-probes";
import { stageKeyReport } from "@curvi/trigger/provider-probes";
import { DEFAULT_SHOT_CONCURRENCY, parseShotConcurrency } from "@curvi/trigger/shot-concurrency";
import { CRON_JOBS, cronFreshness, readCronSuccesses, type CronJob, type CronStatus } from "@/lib/cron-health";
import { compareRecipes, readRecipeRows, type RecipeDrift, type RecipeLike } from "@/lib/recipe-drift";
import { withTimeout, type SqlExecutor } from "@/lib/service-health";

export interface HealthWarning {
  /** Short stable code, safe to show publicly. */
  code: string;
  /** Plain sentence for the founder. Never an env value. */
  message: string;
}

export interface MemoryReport {
  /** Container memory limit from the cgroup, null when unlimited or unknown. */
  limitBytes: number | null;
  rssBytes: number;
  /** RSS as a whole percent of the limit, null without a limit. */
  rssPercentOfLimit: number | null;
}

export interface ConfigReport {
  warnings: HealthWarning[];
  /** null when the table was not read (demo mode, database down or read failed). */
  recipes: { drift: RecipeDrift[] } | null;
  providerKeys: StageKeyReport[];
  /** null when the database was not read. */
  crons: CronStatus[] | null;
  runtime: {
    shotConcurrency: { configured: string | null; effective: number };
    memory: MemoryReport;
  };
  generatedAt: string;
}

export interface ConfigReportDeps {
  mode: "demo" | "db";
  /** Whether the database answered this health check. */
  databaseOk: boolean;
  db?: () => SqlExecutor;
  readEnv: (name: string) => string | undefined;
  storageConfigured: boolean;
  providerTargets: LiveProviderTarget[];
  seedRecipes: readonly RecipeLike[];
  cronJobs?: readonly CronJob[];
  /** Reads a small text file, null when absent. */
  readTextFile?: (path: string) => string | null;
  rssBytes?: () => number;
  now?: () => Date;
  timeoutMs?: number;
  logger?: Pick<Console, "warn">;
}

/** Share of the container limit above which RSS is reported. */
export const MEMORY_HIGH_RATIO = 0.85;
export const CONFIG_READ_TIMEOUT_MS = 1_500;

/** cgroup v2 first, then the two usual v1 locations. */
const MEMORY_LIMIT_FILES = [
  "/sys/fs/cgroup/memory.max",
  "/sys/fs/cgroup/memory/memory.limit_in_bytes",
  "/sys/fs/cgroup/memory.limit_in_bytes",
];

/** cgroup v1 reports "no limit" as a number near 2^63. */
const UNLIMITED_BYTES = 2 ** 60;

function readTextFileDefault(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The container memory limit in bytes, null when unlimited or unreadable. */
export function readMemoryLimit(readTextFile: (path: string) => string | null = readTextFileDefault): number | null {
  for (const path of MEMORY_LIMIT_FILES) {
    const text = readTextFile(path)?.trim();
    if (!text) continue;
    if (text === "max") return null;
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0) return null;
    return value >= UNLIMITED_BYTES ? null : value;
  }
  return null;
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

const STAGE_KIND_WARNINGS: Record<StageKeyReport["kind"], HealthWarning> = {
  llm: { code: "no_llm_provider", message: "No Anthropic key is set, so the text stages have no live model." },
  image: { code: "no_image_provider", message: "No image provider key is set (Gemini, BFL or OpenAI)." },
  cutout: { code: "no_cutout_provider", message: "No Photoroom key is set, so the cutout stage has no live provider." },
};

export async function buildConfigReport(deps: ConfigReportDeps): Promise<ConfigReport> {
  const now = (deps.now ?? (() => new Date()))();
  const timeoutMs = deps.timeoutMs ?? CONFIG_READ_TIMEOUT_MS;
  const logger = deps.logger ?? console;
  const warnings: HealthWarning[] = [];

  if (!deps.storageConfigured) {
    warnings.push({ code: "storage_not_configured", message: "R2 storage is not configured, so packs cannot be stored." });
  }

  const providerKeys = stageKeyReport(deps.providerTargets);
  for (const kind of ["llm", "image", "cutout"] as const) {
    if (providerKeys.some((stage) => stage.kind === kind && !stage.ready)) {
      warnings.push(STAGE_KIND_WARNINGS[kind]);
    }
  }

  let recipes: ConfigReport["recipes"] = null;
  let crons: CronStatus[] | null = null;
  if (deps.mode === "db" && deps.databaseOk && deps.db) {
    const db = deps.db();
    const [recipeRead, cronRead] = await Promise.allSettled([
      withTimeout(() => readRecipeRows(db), timeoutMs),
      withTimeout(() => readCronSuccesses(db), timeoutMs),
    ]);

    if (recipeRead.status === "fulfilled") {
      const drift = compareRecipes(recipeRead.value, deps.seedRecipes);
      recipes = { drift };
      if (drift.length > 0) {
        const rows = new Set(drift.map((d) => `${d.key}@${d.version}`)).size;
        warnings.push({
          code: "recipe_drift",
          message: `${rows} recipe ${rows === 1 ? "row differs" : "rows differ"} from the seed in this build, so production runs other prompts or models than the code.`,
        });
      }
    } else {
      logger.warn("[health] recipe drift check could not read the recipes table:", describeError(recipeRead.reason));
      warnings.push({ code: "recipe_check_failed", message: "The recipes table could not be read, so drift was not checked." });
    }

    if (cronRead.status === "fulfilled") {
      crons = cronFreshness(cronRead.value, now, deps.cronJobs ?? CRON_JOBS);
      for (const cron of crons) {
        if (cron.state === "never") {
          warnings.push({
            code: `cron_never_ran:${cron.name}`,
            message: `The ${cron.name} cron has never recorded a successful run.`,
          });
        } else if (cron.state === "overdue") {
          warnings.push({
            code: `cron_overdue:${cron.name}`,
            message: `The ${cron.name} cron last succeeded ${cron.ageMinutes} minutes ago. It should run every ${cron.intervalMinutes} minutes.`,
          });
        }
      }
    } else {
      logger.warn("[health] cron freshness check could not read platform_settings:", describeError(cronRead.reason));
      warnings.push({ code: "cron_check_failed", message: "The cron run times could not be read." });
    }
  }

  const configured = deps.readEnv("CURVI_SHOT_CONCURRENCY")?.trim() || null;
  const parsed = parseShotConcurrency(configured ?? undefined);
  if (configured && parsed === undefined) {
    warnings.push({
      code: "shot_concurrency_invalid",
      message: `CURVI_SHOT_CONCURRENCY is not a whole number, so the default of ${DEFAULT_SHOT_CONCURRENCY} applies.`,
    });
  }

  const limitBytes = readMemoryLimit(deps.readTextFile ?? readTextFileDefault);
  const rssBytes = (deps.rssBytes ?? (() => process.memoryUsage.rss()))();
  const rssPercentOfLimit = limitBytes ? Math.round((rssBytes / limitBytes) * 100) : null;
  if (limitBytes && rssBytes >= limitBytes * MEMORY_HIGH_RATIO) {
    warnings.push({
      code: "memory_high",
      message: `The process uses ${rssPercentOfLimit} percent of the container memory limit.`,
    });
  }

  return {
    warnings,
    recipes,
    providerKeys,
    crons,
    runtime: {
      // A whole number is echoed back; anything else is reported as set
      // but ignored, without repeating the value.
      shotConcurrency: {
        configured: configured === null ? null : parsed === undefined ? "invalid" : configured,
        effective: parsed ?? DEFAULT_SHOT_CONCURRENCY,
      },
      memory: { limitBytes, rssBytes, rssPercentOfLimit },
    },
    generatedAt: now.toISOString(),
  };
}

/** Recent report per instance, so the database reads run at most once a
 * minute however often Render polls. */
export interface ConfigReportCache {
  report: ConfigReport | null;
  databaseOk: boolean;
  at: number;
}

export const CONFIG_REPORT_TTL_MS = 60_000;

export function createConfigReportCache(): ConfigReportCache {
  return { report: null, databaseOk: false, at: 0 };
}

/** The cached report when it is recent and was built with the same
 * database state; a fresh one otherwise (or when `fresh` is asked for). */
export async function cachedConfigReport(
  cache: ConfigReportCache,
  opts: { databaseOk: boolean; fresh?: boolean; nowMs?: number; ttlMs?: number },
  build: () => Promise<ConfigReport>,
): Promise<ConfigReport> {
  const nowMs = opts.nowMs ?? Date.now();
  const ttlMs = opts.ttlMs ?? CONFIG_REPORT_TTL_MS;
  if (!opts.fresh && cache.report && cache.databaseOk === opts.databaseOk && nowMs - cache.at < ttlMs) {
    return cache.report;
  }
  const report = await build();
  cache.report = report;
  cache.databaseOk = opts.databaseOk;
  cache.at = nowMs;
  return report;
}
