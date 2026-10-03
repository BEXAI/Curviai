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
 * - billing: Stripe readiness, a quiet webhook and the webhook endpoint
 *   check (lib/billing/billing-health.ts, PHASE_20 P20-01 and P20-02);
 * - CURVI_SHOT_CONCURRENCY, the container memory limit and current RSS;
 * - the database size against the Supabase Free plan limit (db_size_high
 *   from the seeded share of it, PHASE_20.md P20-15; past the limit the
 *   project turns read only);
 * - the OpenAI credit window from the seed: a warning from the first
 *   reminder date until the credits expire, and after (lib/llm-spend.ts);
 * - with includeLlmSpend (the detailed report), LLM spend and tokens per
 *   provider for the last 7 UTC days (PHASE_17.md workstream 6), and the
 *   newest fal balance reading per account (PHASE_18.md P18-03);
 * - a fal inference key set without the Admin API key that reads its
 *   balance (fal_admin_key_missing, PHASE_18.md P18-03).
 *
 * The database reads run only when the database answered, each under its own
 * timeout, and a failed read becomes a warning instead of an error.
 */

import { readFileSync } from "node:fs";
import { falBalanceAccounts, falBalanceLines, healthLimits as seededHealthLimits, modelRetirementNotices, type HealthLimits, type LlmModelRetirement } from "@curvi/pipeline/seed";
import { sql } from "@curvi/db";
import { readFalBalances, type StoredFalBalance } from "@curvi/trigger/provider-balance";
import type { LiveProviderTarget, StageKeyReport } from "@curvi/trigger/provider-probes";
import { stageKeyReport } from "@curvi/trigger/provider-probes";
import { DEFAULT_SHOT_CONCURRENCY, parseShotConcurrency } from "@curvi/trigger/shot-concurrency";
import { CRON_JOBS, cronFreshness, readCronSuccesses, type CronJob, type CronStatus } from "@/lib/cron-health";
import { readLifecycleEmailWarning } from "@/lib/email/health";
import { llmCreditWarnings, readLlmSpend } from "@/lib/llm-spend";
import { compareRecipes, readRecipeRows, type RecipeDrift, type RecipeLike } from "@/lib/recipe-drift";
import { billingHealth, type BillingHealth } from "@/lib/billing/billing-health";
import type { LlmSpendReport } from "@curvi/trigger/llm-monitor";
import { withTimeout, type SqlExecutor } from "@/lib/service-health";

export interface HealthWarning {
  /** Short stable code, safe to show publicly. */
  code: string;
  /** Plain sentence for the founder. Never an env value. */
  message: string;
  /** Retirement warnings are informational until the seeded urgent window. */
  severity?: "info" | "degraded";
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
  /** The database size against the seeded Free plan limit (P20-15); null
   * when the database was not read or the read failed. */
  databaseSize: DatabaseSizeReport | null;
  /** null when the database was not read. */
  crons: CronStatus[] | null;
  /** Billing is meant to be live (lib/billing/billing-health.ts); the
   * health route classifies the readiness problems with it. */
  billingLive: boolean;
  /** LLM spend per provider and recipe for the last days; null when not
   * asked for (the public check) or the counters could not be read. */
  llmSpend: LlmSpendReport | null;
  /** The newest fal balance reading per account (detailed report only);
   * null when not asked for or not readable. */
  falBalances: StoredFalBalance[] | null;
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
  /** Read the LLM spend counters too: only for the detailed report, so the
   * public poll stays at its two reads. */
  includeLlmSpend?: boolean;
  /** Reads a small text file, null when absent. */
  readTextFile?: (path: string) => string | null;
  /** The size limits (P20-15); the seed's healthLimits by default. */
  healthLimits?: HealthLimits;
  modelRetirements?: readonly LlmModelRetirement[];
  rssBytes?: () => number;
  now?: () => Date;
  timeoutMs?: number;
  logger?: Pick<Console, "warn">;
}

export interface DatabaseSizeReport {
  bytes: number;
  limitBytes: number;
  /** bytes as a whole percent of the limit. */
  percentOfLimit: number;
}

/** The database size the way Supabase measures it for the plan limit (its
 * "Database size" page, checked 2026-10-01): every database's
 * pg_database_size, added up. */
export async function readDatabaseSize(db: SqlExecutor): Promise<number> {
  const result = await db.execute(sql`select sum(pg_database_size(datname))::text as bytes from pg_database`);
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] } | null)?.rows ?? [])) as Array<{
    bytes?: unknown;
  }>;
  const bytes = Number(rows[0]?.bytes);
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new Error("pg_database_size returned no number");
  }
  return bytes;
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

/** The warning for LLM stages no set key covers. The code stays
 * no_llm_provider; the message names the stages and the keys that would
 * cover them. */
function llmStageWarning(missing: StageKeyReport[]): HealthWarning {
  const stages = missing.map((stage) => stage.stage);
  const keys = [...new Set(missing.flatMap((stage) => stage.keys.map((key) => key.envVar)))].sort();
  const one = stages.length === 1;
  return {
    code: "no_llm_provider",
    message: `No model key is set for the ${joinWords(stages)} ${one ? "stage" : "stages"}. Set ${joinWords(keys, "or")} to run ${one ? "it" : "them"} live.`,
  };
}

function joinWords(words: readonly string[], conjunction = "and"): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} ${conjunction} ${words[words.length - 1]}`;
}

const STAGE_KIND_WARNINGS: Record<StageKeyReport["kind"], HealthWarning> = {
  llm: { code: "no_llm_provider", message: "No OpenAI or Anthropic key is set, so the text stages have no live model." },
  image: { code: "no_image_provider", message: "No image provider key is set (Gemini, BFL or OpenAI)." },
  cutout: { code: "no_cutout_provider", message: "No fal key (FAL_KEY) is set, so the cutout stage has no live provider." },
};

export async function buildConfigReport(deps: ConfigReportDeps): Promise<ConfigReport> {
  const now = (deps.now ?? (() => new Date()))();
  const timeoutMs = deps.timeoutMs ?? CONFIG_READ_TIMEOUT_MS;
  const logger = deps.logger ?? console;
  const warnings: HealthWarning[] = [];

  const turnstileSite = deps.readEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY");
  const turnstileSecret = deps.readEnv("TURNSTILE_SECRET_KEY");
  if (Boolean(turnstileSite) !== Boolean(turnstileSecret)) {
    warnings.push({ code: "turnstile_secret_missing", message: "Turnstile needs both its public site key and server secret. Protected requests fail closed until both are set." });
  }

  if (!deps.storageConfigured) {
    warnings.push({ code: "storage_not_configured", message: "R2 storage is not configured, so packs cannot be stored." });
  }

  // Every read runs at once, each under its own timeout, so the report
  // stays well inside Render's 5 second health check timeout (security
  // review 5): the billing signals, the recipe, cron and spend reads, and
  // the database size.
  const dbReady = deps.mode === "db" && deps.databaseOk && deps.db ? deps.db : null;
  const limits = deps.healthLimits ?? seededHealthLimits;
  const billingRead: Promise<BillingHealth> = billingHealth({
    readEnv: deps.readEnv,
    db: dbReady ?? undefined,
    now,
    timeoutMs,
    logger,
  }).catch((err: unknown) => {
    logger.warn("[health] billing checks failed:", describeError(err));
    return { warnings: [], billingLive: false };
  });
  const db = dbReady ? dbReady() : null;
  const reads = db
    ? Promise.allSettled([
        withTimeout(() => readRecipeRows(db), timeoutMs),
        withTimeout(() => readCronSuccesses(db), timeoutMs),
        deps.includeLlmSpend ? withTimeout(() => readLlmSpend(db, now), timeoutMs) : Promise.resolve(null),
        withTimeout(() => readDatabaseSize(db), timeoutMs),
        // P18-03: the stored fal balances, reported beside the LLM spend.
        withTimeout(async () => [...(await readFalBalances(db as never)).values()], timeoutMs),
      ] as const)
    : null;
  const [billing, settled] = await Promise.all([billingRead, reads]);

  // P20-01, P20-02 and P20-07: Stripe readiness, the billing sender, a quiet
  // webhook and the endpoint check (lib/billing/billing-health.ts).
  warnings.push(...billing.warnings);

  const providerKeys = stageKeyReport(deps.providerTargets);
  for (const kind of ["llm", "image", "cutout"] as const) {
    const missing = providerKeys.filter((stage) => stage.kind === kind && !stage.ready);
    if (missing.length === 0) continue;
    // An LLM stage runs on any model in its chains, OpenAI or Claude, so the
    // warning names each stage no set key covers (PHASE_17 workstream 3).
    warnings.push(kind === "llm" ? llmStageWarning(missing) : STAGE_KIND_WARNINGS[kind]);
  }

  warnings.push(...llmCreditWarnings(now));

  // P18-03: a fal account whose balance nobody can read gives no low
  // balance email and never closes the acquisition gate on its balance.
  const unprobed = falBalanceAccounts.filter((account) => deps.readEnv(account.keyEnv) && !deps.readEnv(account.adminKeyEnv));
  if (unprobed.length > 0) {
    const pairs = unprobed.map((account) => `${account.keyEnv} is set without ${account.adminKeyEnv}`);
    warnings.push({
      code: "fal_admin_key_missing",
      message: `${joinWords(pairs)}, so that fal balance is never checked and no low balance email can go out.`,
    });
  }

  let recipes: ConfigReport["recipes"] = null;
  let crons: CronStatus[] | null = null;
  let llmSpend: LlmSpendReport | null = null;
  let falBalances: StoredFalBalance[] | null = null;
  let retirementRecipes = deps.seedRecipes;
  if (settled && db) {
    const [recipeRead, cronRead, spendRead, , balanceRead] = settled;
    if (balanceRead.status === "fulfilled") {
      falBalances = deps.includeLlmSpend ? balanceRead.value : null;
      if (balanceRead.value.some((balance) => balance.ok && balance.balanceUsd !== null && balance.balanceUsd < falBalanceLines.alertUsd)) {
        warnings.push({ code: "fal_balance_low", message: "A configured fal account is below the seeded balance alert line." });
      }
    } else {
      logger.warn("[health] fal balance report could not read platform_settings:", describeError(balanceRead.reason));
    }

    if (spendRead.status === "fulfilled") {
      llmSpend = spendRead.value;
    } else {
      // Reporting only: the details show null, no warning.
      logger.warn("[health] LLM spend report could not read spend_cap_counters:", describeError(spendRead.reason));
    }

    if (recipeRead.status === "fulfilled") {
      // Production can contain a model absent from this build's seed. When
      // the table has no active rows, the worker falls back to the seed.
      if (recipeRead.value.some((row) => row.active)) retirementRecipes = recipeRead.value;
      const drift = compareRecipes(recipeRead.value, deps.seedRecipes);
      recipes = { drift };
      if (drift.length > 0) {
        const rows = new Set(drift.map((d) => `${d.key}@${d.version}`)).size;
        warnings.push({
          code: "recipe_drift",
          message: `${rows} recipe ${rows === 1 ? "row differs" : "rows differ"} from the seed in this build. Check models, prompt hashes, active versions and traffic percentages before re-seeding.`,
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

    // P18-06: lifecycle email switched on with a variable missing.
    try {
      const emailWarning = await withTimeout(() => readLifecycleEmailWarning(db, deps.readEnv), timeoutMs);
      if (emailWarning) warnings.push(emailWarning);
    } catch (err) {
      logger.warn("[health] lifecycle email check could not read platform_settings:", describeError(err));
    }
  }

  for (const notice of modelRetirementNotices(retirementRecipes, now, deps.modelRetirements)) {
    const meaning = notice.dateKind === "not-sooner-than"
      ? "This is an earliest possible retirement bound, not an announced shutdown. Recheck the provider notice before changing models."
      : "This is an announced retirement. Evaluate a supported replacement before that date.";
    warnings.push({ code: `llm_model_retiring:${notice.model}`, severity: notice.severity,
      message: `${notice.model} is in an active recipe chain. Its published retirement date or bound is ${notice.earliestRetirementDate}, checked ${notice.checkedOn}. ${meaning} Source: ${notice.source}` });
  }

  // P20-15: the database against the Free plan size limit, read once a
  // minute at most with the rest of the report.
  let databaseSize: DatabaseSizeReport | null = null;
  if (settled) {
    const sizeRead = settled[3];
    if (sizeRead.status === "fulfilled") {
      const bytes = sizeRead.value;
      databaseSize = {
        bytes,
        limitBytes: limits.dbSizeLimitBytes,
        percentOfLimit: Math.round((bytes / limits.dbSizeLimitBytes) * 100),
      };
      if (bytes >= limits.dbSizeLimitBytes * limits.dbSizeHighRatio) {
        const mb = (value: number) => Math.round(value / (1024 * 1024));
        warnings.push({
          code: "db_size_high",
          message: `The database holds ${mb(bytes)} MB, ${databaseSize.percentOfLimit} percent of the ${mb(limits.dbSizeLimitBytes)} MB plan limit. Past the limit Supabase turns it read only.`,
        });
      }
    } else {
      logger.warn("[health] database size check could not read pg_database_size:", describeError(sizeRead.reason));
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
    databaseSize,
    crons,
    billingLive: billing.billingLive,
    llmSpend,
    falBalances,
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
