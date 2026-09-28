/**
 * The checks behind GET /api/health, the endpoint Render polls
 * (healthCheckPath) and uptime monitors watch.
 *
 * It stays fast and cheap: a select 1 on the app database, a schema check
 * against the migration journal compiled into this build, and the inline
 * pack runner's state. Each database step has its own timeout well under
 * Render's five second limit. Nothing in the response is secret: no env
 * values, no hostnames, no error messages (those go to the server log).
 *
 * Unhealthy (HTTP 503) means one of:
 * - the database does not answer,
 * - the database is behind the migrations this build expects, so a deploy
 *   whose migrations were not applied never receives traffic,
 * - the instance is draining for shutdown.
 * A schema that cannot be read (no drizzle bookkeeping table) is reported as
 * unknown without failing the check. Missing configuration (no R2 storage, no
 * model provider key) is listed under `warnings` without failing it either:
 * a restart cannot fix an env value, and failing would restart the instance
 * every minute and take the marketing site down with it.
 */

import journal from "../../../../packages/db/migrations/meta/_journal.json";
import type { InlineRunnerStats } from "@/lib/jobs/inline-runner";

export type DatabaseCheck = "ok" | "failed" | "skipped";
export type SchemaCheck = "current" | "behind" | "unknown" | "skipped";
export type PackRunnerCheck = "idle" | "accepting" | "draining";

export interface MigrationMark {
  tag: string;
  when: number;
}

export interface HealthBody {
  ok: boolean;
  mode: "demo" | "db";
  checks: {
    database: DatabaseCheck;
    schema: SchemaCheck;
    packRunner: PackRunnerCheck;
  };
  migrations: {
    /** Newest migration this build ships. */
    expected: string;
    /** Newest migration the database has recorded, when readable. */
    applied: string | null;
  };
  packs: { running: number; waiting: number; concurrency: number } | null;
  /** Stable codes for configuration a db mode instance needs to deliver
   * packs, such as "storage_not_configured". Never env values. */
  warnings: string[];
  /** Short commit of the running deploy (Render sets RENDER_GIT_COMMIT). */
  commit: string | null;
  uptimeSeconds: number;
  checkedAt: string;
}

export interface HealthResult {
  status: 200 | 503;
  body: HealthBody;
}

export interface HealthCheckDeps {
  mode: "demo" | "db";
  /** Runs select 1 on the app database. */
  pingDatabase: () => Promise<void>;
  /** created_at of the newest drizzle.__drizzle_migrations row (the journal
   * `when` of the last applied migration), or null when there is none. May
   * throw when the table does not exist. */
  latestAppliedMigration: () => Promise<number | null>;
  /** The inline pack runner's counters, or null when none was created yet. */
  runnerStats: () => InlineRunnerStats | null;
  /** Configuration warning codes; consulted in db mode only. */
  configWarnings?: () => string[];
  /** Migrations this build ships, from the journal. */
  migrations?: MigrationMark[];
  commit?: string | null;
  /** Per database step timeout. */
  timeoutMs?: number;
  /** Remembers a current schema across calls: a database never moves back
   * to an older migration, so a current schema needs no second look. */
  cache?: SchemaCache;
  uptimeSeconds?: () => number;
  now?: () => Date;
  logger?: Pick<Console, "warn">;
}

export interface SchemaCache {
  schemaCurrent: boolean;
  applied: string | null;
}

export const HEALTH_DB_TIMEOUT_MS = 2_000;

interface JournalFile {
  entries: Array<{ idx: number; tag: string; when: number }>;
}

/** Migrations this build ships, in journal order. */
export function journalMigrations(): MigrationMark[] {
  return [...(journal as JournalFile).entries]
    .sort((a, b) => a.idx - b.idx)
    .map((e) => ({ tag: e.tag, when: e.when }));
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

async function withTimeout<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** For the server log only, never the response body. */
function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Compares the newest applied migration with the newest one this build
 * ships. Drizzle records each migration with its journal `when`, and applies
 * only migrations newer than its newest record, so the same comparison
 * decides whether this build's schema is in place. */
export function compareSchema(
  appliedWhen: number | null,
  migrations: MigrationMark[],
): { state: "current" | "behind" | "unknown"; applied: string | null } {
  if (appliedWhen === null || !Number.isFinite(appliedWhen)) {
    return { state: "unknown", applied: null };
  }
  const expected = migrations[migrations.length - 1];
  const appliedTag = migrations.find((m) => m.when === appliedWhen)?.tag ?? null;
  if (!expected) {
    return { state: "current", applied: appliedTag };
  }
  return { state: appliedWhen >= expected.when ? "current" : "behind", applied: appliedTag };
}

export async function runHealthCheck(deps: HealthCheckDeps): Promise<HealthResult> {
  const migrations = deps.migrations ?? journalMigrations();
  const timeoutMs = deps.timeoutMs ?? HEALTH_DB_TIMEOUT_MS;
  const logger = deps.logger ?? console;
  const expected = migrations[migrations.length - 1]?.tag ?? "none";

  let database: DatabaseCheck = "skipped";
  let schema: SchemaCheck = "skipped";
  let applied: string | null = null;

  if (deps.mode === "db") {
    try {
      await withTimeout(deps.pingDatabase, timeoutMs);
      database = "ok";
    } catch (err) {
      database = "failed";
      logger.warn("[health] database check failed:", describeError(err));
    }

    if (database === "failed") {
      schema = "unknown";
    } else if (deps.cache?.schemaCurrent) {
      schema = "current";
      applied = deps.cache.applied;
    } else {
      try {
        const compared = compareSchema(await withTimeout(deps.latestAppliedMigration, timeoutMs), migrations);
        schema = compared.state;
        applied = compared.applied;
      } catch (err) {
        schema = "unknown";
        logger.warn("[health] schema check could not read the migration table:", describeError(err));
      }
      if (schema === "current" && deps.cache) {
        deps.cache.schemaCurrent = true;
        deps.cache.applied = applied;
      }
    }
  }

  const stats = deps.runnerStats();
  const packRunner: PackRunnerCheck = !stats ? "idle" : stats.draining ? "draining" : "accepting";
  const ok = database !== "failed" && schema !== "behind" && packRunner !== "draining";

  return {
    status: ok ? 200 : 503,
    body: {
      ok,
      mode: deps.mode,
      checks: { database, schema, packRunner },
      migrations: { expected, applied },
      packs: stats ? { running: stats.running, waiting: stats.waiting, concurrency: stats.concurrency } : null,
      warnings: deps.mode === "db" ? (deps.configWarnings?.() ?? []) : [],
      commit: deps.commit ? deps.commit.slice(0, 7) : null,
      uptimeSeconds: Math.round((deps.uptimeSeconds ?? (() => process.uptime()))()),
      checkedAt: (deps.now ?? (() => new Date()))().toISOString(),
    },
  };
}
