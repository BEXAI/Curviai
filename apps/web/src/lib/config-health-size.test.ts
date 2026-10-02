import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@curvi/db/testing";
import { healthLimits } from "@curvi/pipeline/seed";
import { liveProviderTargets } from "@curvi/trigger/provider-probes";
import { buildConfigReport, readDatabaseSize, type ConfigReportDeps } from "./config-health";
import type { SqlExecutor } from "./service-health";

// docs/phases/PHASE_20.md P20-15: db_size_high at the seeded share of the
// Supabase Free plan's 500 MB, past which the project turns read only.

const LIMITS = { ...healthLimits, dbSizeLimitBytes: 1_000, dbSizeHighRatio: 0.7 };

/** A database whose size read answers `bytes` (or fails), and whose other
 * reads answer nothing. */
function sizedDb(bytes: number | Error): SqlExecutor {
  return {
    execute: async (query) => {
      if (JSON.stringify(query).includes("pg_database_size")) {
        if (bytes instanceof Error) throw bytes;
        return [{ bytes: String(bytes) }];
      }
      return [];
    },
  };
}

function deps(db: SqlExecutor, overrides: Partial<ConfigReportDeps> = {}): ConfigReportDeps {
  const readEnv = () => undefined;
  return {
    mode: "db",
    databaseOk: true,
    db: () => db,
    readEnv,
    storageConfigured: true,
    providerTargets: liveProviderTargets(readEnv),
    seedRecipes: [],
    healthLimits: LIMITS,
    rssBytes: () => 1,
    readTextFile: () => null,
    now: () => new Date("2026-10-01T12:00:00Z"),
    logger: { warn: () => undefined },
    ...overrides,
  };
}

const codes = (report: { warnings: Array<{ code: string }> }) => report.warnings.map((warning) => warning.code);

describe("db_size_high", () => {
  it("stays quiet below the seeded share and reports the size", async () => {
    const report = await buildConfigReport(deps(sizedDb(699)));
    expect(codes(report)).not.toContain("db_size_high");
    expect(report.databaseSize).toEqual({ bytes: 699, limitBytes: 1_000, percentOfLimit: 70 });
  });

  it("warns at the seeded share of the limit, in plain words", async () => {
    const report = await buildConfigReport(
      deps(sizedDb(400 * 1024 * 1024), { healthLimits: { ...healthLimits, dbSizeLimitBytes: 500 * 1024 * 1024 } }),
    );
    const warning = report.warnings.find((w) => w.code === "db_size_high");
    expect(warning?.message).toBe(
      "The database holds 400 MB, 80 percent of the 500 MB plan limit. Past the limit Supabase turns it read only.",
    );
    expect(warning?.message).not.toMatch(/ [-–—] |→|->/);
  });

  it("uses the seed's limits by default", async () => {
    const atLine = Math.ceil(healthLimits.dbSizeLimitBytes * healthLimits.dbSizeHighRatio);
    const below = await buildConfigReport(deps(sizedDb(atLine - 1), { healthLimits: undefined }));
    const at = await buildConfigReport(deps(sizedDb(atLine), { healthLimits: undefined }));
    expect(codes(below)).not.toContain("db_size_high");
    expect(codes(at)).toContain("db_size_high");
  });

  it("logs a failed read without a warning, and skips it when the database is down", async () => {
    const warn = vi.fn();
    const failed = await buildConfigReport(deps(sizedDb(new Error("permission denied")), { logger: { warn } }));
    expect(codes(failed)).not.toContain("db_size_high");
    expect(failed.databaseSize).toBeNull();
    expect(warn.mock.calls.some((call) => String(call[0]).includes("database size"))).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("permission denied");

    const execute = vi.fn();
    const down = await buildConfigReport(deps({ execute }, { databaseOk: false }));
    expect(execute).not.toHaveBeenCalled();
    expect(down.databaseSize).toBeNull();
  });
});

describe("readDatabaseSize on Postgres (PGlite)", () => {
  let client: Awaited<ReturnType<typeof createTestDb>>["client"];
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];

  beforeAll(async () => {
    ({ client, db } = await createTestDb());
  });

  afterAll(async () => {
    await client.close();
  });

  it("adds up pg_database_size over every database", async () => {
    const bytes = await readDatabaseSize(db as unknown as SqlExecutor);
    expect(Number.isInteger(bytes)).toBe(true);
    expect(bytes).toBeGreaterThan(0);
  });
});
