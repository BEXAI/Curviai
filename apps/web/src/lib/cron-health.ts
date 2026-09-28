/**
 * Cron freshness for GET /api/health. Each scheduled route records its last
 * successful run in platform_settings under `cron:<name>:last_success`
 * (a platform table the web database role already writes; no migration),
 * and the health check warns when a cron has never succeeded or its last
 * success is older than twice its interval, which catches a scheduler that
 * was never set up, lost its secret or keeps failing.
 */

import { platformSettings, sql, type Db } from "@curvi/db";
import type { SqlExecutor } from "@/lib/service-health";

/** The scheduled routes under /api/cron and how often they should run. */
export const CRON_JOBS = [
  { name: "stale-jobs", intervalMinutes: 10 },
  { name: "purge-source-media", intervalMinutes: 24 * 60 },
] as const;

export type CronName = (typeof CRON_JOBS)[number]["name"];

export interface CronJob {
  name: string;
  intervalMinutes: number;
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
  name: CronName,
  at: Date = new Date(),
  logger: Pick<Console, "warn"> = console,
): Promise<void> {
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

/** A cron is overdue once its last success is older than twice its interval. */
export function cronFreshness(
  successes: Record<string, string>,
  now: Date,
  jobs: readonly CronJob[] = CRON_JOBS,
): CronStatus[] {
  return jobs.map((job) => {
    const lastSuccess = successes[job.name] ?? null;
    if (!lastSuccess) {
      return { name: job.name, intervalMinutes: job.intervalMinutes, lastSuccess: null, ageMinutes: null, state: "never" };
    }
    const ageMs = Math.max(0, now.getTime() - Date.parse(lastSuccess));
    const state: CronState = ageMs > 2 * job.intervalMinutes * 60_000 ? "overdue" : "fresh";
    return {
      name: job.name,
      intervalMinutes: job.intervalMinutes,
      lastSuccess,
      ageMinutes: Math.floor(ageMs / 60_000),
      state,
    };
  });
}
