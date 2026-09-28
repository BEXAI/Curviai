import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compareSchema,
  journalMigrations,
  runHealthCheck,
  type HealthCheckDeps,
  type MigrationMark,
  type SchemaCache,
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
    const cache: SchemaCache = { schemaCurrent: false, applied: null };
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
    const cache: SchemaCache = { schemaCurrent: false, applied: null };
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

  it("reports pack runner load and returns 503 while draining", async () => {
    const accepting = await runHealthCheck(
      deps({ runnerStats: () => ({ concurrency: 2, running: 1, waiting: 3, draining: false }) }),
    );
    expect(accepting.status).toBe(200);
    expect(accepting.body.checks.packRunner).toBe("accepting");
    expect(accepting.body.packs).toEqual({ running: 1, waiting: 3, concurrency: 2 });

    const draining = await runHealthCheck(
      deps({ runnerStats: () => ({ concurrency: 2, running: 1, waiting: 0, draining: true }) }),
    );
    expect(draining.status).toBe(503);
    expect(draining.body.checks.packRunner).toBe("draining");
  });
});
