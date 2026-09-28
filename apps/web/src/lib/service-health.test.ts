import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, readJournalEntries, type TestDb } from "@curvi/db/testing";
import { sql } from "@curvi/db";
import {
  compareSchema,
  createHealthCache,
  journalMigrations,
  readLatestAppliedMigration,
  runHealthCheck,
  type HealthCache,
  type HealthCheckDeps,
  type MigrationMark,
} from "./service-health";

const MIGRATIONS: MigrationMark[] = [
  { tag: "0009_provision_workspace", when: 1000 },
  { tag: "0010_spend_cap_counters", when: 2000 },
  { tag: "0011_next", when: 3000 },
];

const quiet = { warn: () => undefined };

function deps(overrides: Partial<HealthCheckDeps> = {}): HealthCheckDeps {
  return {
    mode: "db",
    pingDatabase: async () => undefined,
    latestAppliedMigration: async () => 3000,
    runnerStats: () => null,
    migrations: MIGRATIONS,
    timeoutMs: 50,
    uptimeSeconds: () => 12.4,
    now: () => new Date("2026-09-28T12:00:00Z"),
    logger: quiet,
    ...overrides,
  };
}

describe("journalMigrations", () => {
  it("matches the migration journal this build ships, newest last", () => {
    const journal = JSON.parse(
      readFileSync(new URL("../../../../packages/db/migrations/meta/_journal.json", import.meta.url), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const newest = [...journal.entries].sort((a, b) => a.idx - b.idx).at(-1);
    const marks = journalMigrations();
    expect(marks.length).toBe(journal.entries.length);
    expect(marks.at(-1)).toEqual({ tag: newest?.tag, when: newest?.when });
  });
});

describe("compareSchema", () => {
  it("is current when the newest applied migration is the newest shipped", () => {
    expect(compareSchema(3000, MIGRATIONS)).toEqual({ state: "current", applied: "0011_next" });
  });

  it("is current when the database is ahead of this build (migrations go first)", () => {
    expect(compareSchema(4000, MIGRATIONS)).toEqual({ state: "current", applied: null });
  });

  it("is behind when this build ships a migration the database lacks", () => {
    expect(compareSchema(2000, MIGRATIONS)).toEqual({ state: "behind", applied: "0010_spend_cap_counters" });
  });

  it("is unknown without bookkeeping rows", () => {
    expect(compareSchema(null, MIGRATIONS)).toEqual({ state: "unknown", applied: null });
    expect(compareSchema(Number.NaN, MIGRATIONS)).toEqual({ state: "unknown", applied: null });
  });
});

describe("runHealthCheck", () => {
  it("demo mode is healthy without touching a database", async () => {
    let touched = false;
    const result = await runHealthCheck(
      deps({
        mode: "demo",
        pingDatabase: async () => {
          touched = true;
        },
      }),
    );
    expect(touched).toBe(false);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      mode: "demo",
      checks: { database: "skipped", schema: "skipped", packRunner: "idle" },
      packs: null,
      uptimeSeconds: 12,
      checkedAt: "2026-09-28T12:00:00.000Z",
    });
  });

  it("db mode with a current schema is healthy", async () => {
    const result = await runHealthCheck(deps({ commit: "5068de0abcdef1234" }));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      checks: { database: "ok", schema: "current" },
      migrations: { expected: "0011_next", applied: "0011_next" },
      commit: "5068de0",
    });
  });

  it("returns 503 when the database does not answer, without leaking the error", async () => {
    const result = await runHealthCheck(
      deps({
        pingDatabase: async () => {
          throw new Error("connect ECONNREFUSED db.internal.example:5432 password=hunter2");
        },
      }),
    );
    expect(result.status).toBe(503);
    expect(result.body.ok).toBe(false);
    expect(result.body.checks).toMatchObject({ database: "failed", schema: "unknown" });
    const text = JSON.stringify(result.body);
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("example");
  });

  it("returns 503 when the database check hangs past the timeout", async () => {
    const result = await runHealthCheck(
      deps({
        timeoutMs: 20,
        pingDatabase: () => new Promise<void>(() => undefined),
      }),
    );
    expect(result.status).toBe(503);
    expect(result.body.checks.database).toBe("failed");
  });

  it("returns 503 when the database is behind this build's migrations", async () => {
    const result = await runHealthCheck(deps({ latestAppliedMigration: async () => 2000 }));
    expect(result.status).toBe(503);
    expect(result.body.checks.schema).toBe("behind");
    expect(result.body.migrations).toEqual({ expected: "0011_next", applied: "0010_spend_cap_counters" });
  });

  it("reports an unreadable migration table as unknown without failing", async () => {
    const result = await runHealthCheck(
      deps({
        latestAppliedMigration: async () => {
          throw new Error('relation "drizzle.__drizzle_migrations" does not exist');
        },
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body.checks.schema).toBe("unknown");
  });

  it("remembers a current schema and stops querying it", async () => {
    const cache: HealthCache = createHealthCache();
    let reads = 0;
    const counting = deps({
      cache,
      latestAppliedMigration: async () => {
        reads += 1;
        return 3000;
      },
    });
    await runHealthCheck(counting);
    const second = await runHealthCheck(counting);
    expect(reads).toBe(1);
    expect(second.body.checks.schema).toBe("current");
    expect(second.body.migrations.applied).toBe("0011_next");
  });

  it("keeps rechecking a schema that is behind", async () => {
    const cache: HealthCache = createHealthCache();
    let applied = 2000;
    const check = deps({ cache, latestAppliedMigration: async () => applied });
    expect((await runHealthCheck(check)).status).toBe(503);
    applied = 3000;
    expect((await runHealthCheck(check)).status).toBe(200);
  });

  it("lists configuration warnings in db mode without failing", async () => {
    const result = await runHealthCheck(deps({ configWarnings: () => ["storage_not_configured"] }));
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.warnings).toEqual(["storage_not_configured"]);

    const demo = await runHealthCheck(deps({ mode: "demo", configWarnings: () => ["storage_not_configured"] }));
    expect(demo.body.warnings).toEqual([]);
  });

  it("passes the database outcome to the async configuration check and survives its failure", async () => {
    const seen: string[] = [];
    const ok = await runHealthCheck(
      deps({
        configWarnings: async ({ database }) => {
          seen.push(database);
          return ["recipe_drift"];
        },
      }),
    );
    expect(ok.body.warnings).toEqual(["recipe_drift"]);
    expect(seen).toEqual(["ok"]);

    const warn = vi.fn();
    const failed = await runHealthCheck(
      deps({
        logger: { warn },
        configWarnings: async () => {
          throw new Error("drift read exploded");
        },
      }),
    );
    expect(failed.status).toBe(200);
    expect(failed.body.ok).toBe(true);
    expect(failed.body.warnings).toEqual(["config_check_failed"]);
    expect(JSON.stringify(failed.body)).not.toContain("exploded");
    expect(warn).toHaveBeenCalled();
  });

  it("reports pack runner load and returns 503 while draining", async () => {
    const accepting = await runHealthCheck(
      deps({ runnerStats: () => ({ concurrency: 2, running: 1, waiting: 3, overdue: 1, draining: false }) }),
    );
    expect(accepting.status).toBe(200);
    expect(accepting.body.checks.packRunner).toBe("accepting");
    expect(accepting.body.packs).toEqual({ running: 1, waiting: 3, overdue: 1, concurrency: 2 });

    const draining = await runHealthCheck(
      deps({ runnerStats: () => ({ concurrency: 2, running: 1, waiting: 0, overdue: 0, draining: true }) }),
    );
    expect(draining.status).toBe(503);
    expect(draining.body.checks.packRunner).toBe("draining");
  });
});

describe("runHealthCheck boot readiness gate", () => {
  const down = async (): Promise<void> => {
    throw new Error("connect ETIMEDOUT");
  };

  it("fails with 503 while the database has never answered on this instance", async () => {
    const cache = createHealthCache();
    const first = await runHealthCheck(deps({ cache, pingDatabase: down }));
    expect(first.status).toBe(503);
    expect(cache.passedOnce).toBe(false);
    // Still gated on the next call: nothing has passed yet.
    expect((await runHealthCheck(deps({ cache, pingDatabase: down }))).status).toBe(503);
  });

  it("answers 200 with ok false for a database failure once a whole check passed", async () => {
    const cache = createHealthCache();
    expect((await runHealthCheck(deps({ cache }))).status).toBe(200);
    expect(cache.passedOnce).toBe(true);

    const outage = await runHealthCheck(deps({ cache, pingDatabase: down }));
    expect(outage.status).toBe(200);
    expect(outage.body.ok).toBe(false);
    expect(outage.body.checks).toMatchObject({ database: "failed", schema: "unknown" });

    const slow = await runHealthCheck(
      deps({ cache, timeoutMs: 20, pingDatabase: () => new Promise<void>(() => undefined) }),
    );
    expect(slow.status).toBe(200);
    expect(slow.body.checks.database).toBe("failed");

    const recovered = await runHealthCheck(deps({ cache }));
    expect(recovered.status).toBe(200);
    expect(recovered.body.ok).toBe(true);
  });

  it("keeps 503 for draining after the gate opened", async () => {
    const cache = createHealthCache();
    await runHealthCheck(deps({ cache }));
    const draining = await runHealthCheck(
      deps({
        cache,
        pingDatabase: down,
        runnerStats: () => ({ concurrency: 1, running: 0, waiting: 0, overdue: 0, draining: true }),
      }),
    );
    expect(draining.status).toBe(503);
  });

  it("keeps a deploy whose schema is behind gated, even through a database blip", async () => {
    const cache = createHealthCache();
    const behind = deps({ cache, latestAppliedMigration: async () => 2000 });
    expect((await runHealthCheck(behind)).status).toBe(503);
    // The database answered, but the instance never passed a whole check, so
    // a failure now must not read as healthy and let Render route to it.
    expect(cache.passedOnce).toBe(false);
    expect((await runHealthCheck(deps({ cache, pingDatabase: down }))).status).toBe(503);
    expect((await runHealthCheck(behind)).status).toBe(503);
  });

  it("does not open the gate while draining", async () => {
    const cache = createHealthCache();
    const draining = await runHealthCheck(
      deps({ cache, runnerStats: () => ({ concurrency: 1, running: 0, waiting: 0, overdue: 0, draining: true }) }),
    );
    expect(draining.status).toBe(503);
    expect(cache.passedOnce).toBe(false);
  });

  it("without a cache treats every call as the first after boot", async () => {
    expect((await runHealthCheck(deps())).status).toBe(200);
    expect((await runHealthCheck(deps({ pingDatabase: down }))).status).toBe(503);
  });
});

describe("readLatestAppliedMigration on Postgres (PGlite)", () => {
  let client: Awaited<ReturnType<typeof createTestDb>>["client"];
  let db: TestDb;
  const shipped = journalMigrations();

  beforeAll(async () => {
    const created = await createTestDb();
    client = created.client;
    db = created.db;
  });

  afterAll(async () => {
    await client.close();
  });

  function check(cache: HealthCache = createHealthCache()) {
    return runHealthCheck(
      deps({
        cache,
        migrations: shipped,
        pingDatabase: async () => {
          await db.execute(sql`select 1`);
        },
        latestAppliedMigration: () => readLatestAppliedMigration(db),
      }),
    );
  }

  async function recordMigration(mark: MigrationMark): Promise<void> {
    await client.query("insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)", [
      `sha256-of-${mark.tag}`,
      mark.when,
    ]);
  }

  it("throws while drizzle has never recorded a migration, which the check reports as unknown", async () => {
    await expect(readLatestAppliedMigration(db)).rejects.toThrow(/__drizzle_migrations/);
    const result = await check();
    expect(result.status).toBe(200);
    expect(result.body.checks).toMatchObject({ database: "ok", schema: "unknown" });
  });

  it("reads drizzle's bookkeeping table and compares it with the shipped journal", async () => {
    // The same schema and table drizzle's migrator creates (drizzle-orm
    // pg-core dialect migrate()): created_at holds each journal `when`.
    await client.exec(`
      create schema if not exists drizzle;
      create table if not exists drizzle.__drizzle_migrations (
        id serial primary key,
        hash text not null,
        created_at bigint
      );
    `);
    expect(await readLatestAppliedMigration(db)).toBeNull();

    // Every migration but the newest, as on a database one deploy behind.
    expect(readJournalEntries().map((e) => e.tag)).toEqual(shipped.map((m) => m.tag));
    for (const mark of shipped.slice(0, -1)) {
      await recordMigration(mark);
    }
    const previous = shipped[shipped.length - 2];
    expect(await readLatestAppliedMigration(db)).toBe(previous.when);
    const behind = await check();
    expect(behind.status).toBe(503);
    expect(behind.body.checks.schema).toBe("behind");
    expect(behind.body.migrations.applied).toBe(previous.tag);

    const newest = shipped[shipped.length - 1];
    await recordMigration(newest);
    expect(await readLatestAppliedMigration(db)).toBe(newest.when);
    const current = await check();
    expect(current.status).toBe(200);
    expect(current.body.checks).toMatchObject({ database: "ok", schema: "current" });
    expect(current.body.migrations).toEqual({ expected: newest.tag, applied: newest.tag });
  });
});
