import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadRecipes, type Db } from "@curvi/db";
import { createTestDb } from "@curvi/db/testing";
import { recipeSeedRows } from "@curvi/pipeline/seed";
import { liveProviderTargets } from "@curvi/trigger/provider-probes";
import {
  buildConfigReport,
  cachedConfigReport,
  createConfigReportCache,
  readMemoryLimit,
  type ConfigReportDeps,
} from "./config-health";
import { recordCronSuccess } from "./cron-health";

const NOW = new Date("2026-09-28T12:00:00Z");
const ALL_KEYS = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "BFL_API_KEY", "OPENAI_API_KEY", "FAL_KEY"];
const GIB = 1024 ** 3;

function envOf(values: Record<string, string>): (name: string) => string | undefined {
  return (name) => values[name] || undefined;
}

function keysEnv(names: string[], extra: Record<string, string> = {}) {
  return envOf({ ...Object.fromEntries(names.map((n) => [n, `secret-${n}`])), ...extra });
}

function baseDeps(overrides: Partial<ConfigReportDeps> = {}): ConfigReportDeps {
  const readEnv = overrides.readEnv ?? keysEnv(ALL_KEYS);
  return {
    mode: "demo",
    databaseOk: false,
    readEnv,
    storageConfigured: true,
    providerTargets: liveProviderTargets(readEnv),
    seedRecipes: recipeSeedRows,
    readTextFile: () => null,
    rssBytes: () => 100 * 1024 ** 2,
    now: () => NOW,
    ...overrides,
  };
}

describe("readMemoryLimit", () => {
  it("reads cgroup v2 first, treats max and the v1 sentinel as no limit", () => {
    expect(readMemoryLimit((p) => (p === "/sys/fs/cgroup/memory.max" ? "536870912\n" : null))).toBe(512 * 1024 ** 2);
    expect(readMemoryLimit((p) => (p === "/sys/fs/cgroup/memory.max" ? "max\n" : null))).toBeNull();
    expect(
      readMemoryLimit((p) => (p === "/sys/fs/cgroup/memory/memory.limit_in_bytes" ? "9223372036854771712" : null)),
    ).toBeNull();
    expect(readMemoryLimit((p) => (p === "/sys/fs/cgroup/memory/memory.limit_in_bytes" ? String(2 * GIB) : null))).toBe(
      2 * GIB,
    );
    expect(readMemoryLimit(() => null)).toBeNull();
  });
});

describe("buildConfigReport without a database", () => {
  it("is clean with every key, storage and a sane runtime", async () => {
    const report = await buildConfigReport(baseDeps());
    expect(report.warnings).toEqual([]);
    expect(report.recipes).toBeNull();
    expect(report.crons).toBeNull();
    expect(report.runtime).toEqual({
      shotConcurrency: { configured: null, effective: 2 },
      memory: { limitBytes: null, rssBytes: 100 * 1024 ** 2, rssPercentOfLimit: null },
    });
  });

  it("warns per missing stage key and never echoes a key value", async () => {
    const readEnv = keysEnv(["BFL_API_KEY"]);
    const report = await buildConfigReport(
      baseDeps({ readEnv, providerTargets: liveProviderTargets(readEnv), storageConfigured: false }),
    );
    expect(report.warnings.map((w) => w.code)).toEqual(["storage_not_configured", "no_llm_provider", "no_cutout_provider"]);
    expect(report.providerKeys.find((s) => s.stage === "scene_plate")?.ready).toBe(true);
    expect(JSON.stringify(report)).not.toContain("secret-");
  });

  it("reports shot concurrency, an invalid value and memory near the limit", async () => {
    const readEnv = keysEnv(ALL_KEYS, { CURVI_SHOT_CONCURRENCY: "4" });
    const ok = await buildConfigReport(
      baseDeps({ readEnv, readTextFile: (p) => (p === "/sys/fs/cgroup/memory.max" ? String(GIB) : null), rssBytes: () => GIB / 2 }),
    );
    expect(ok.runtime).toEqual({
      shotConcurrency: { configured: "4", effective: 4 },
      memory: { limitBytes: GIB, rssBytes: GIB / 2, rssPercentOfLimit: 50 },
    });
    expect(ok.warnings).toEqual([]);

    const bad = await buildConfigReport(
      baseDeps({
        readEnv: keysEnv(ALL_KEYS, { CURVI_SHOT_CONCURRENCY: "lots" }),
        readTextFile: (p) => (p === "/sys/fs/cgroup/memory.max" ? String(GIB) : null),
        rssBytes: () => 0.9 * GIB,
      }),
    );
    expect(bad.warnings.map((w) => w.code)).toEqual(["shot_concurrency_invalid", "memory_high"]);
    expect(bad.runtime.shotConcurrency).toEqual({ configured: "invalid", effective: 2 });
    expect(bad.warnings[1].message).toBe("The process uses 90 percent of the container memory limit.");
  });
});

describe("buildConfigReport with the database", () => {
  let client: Awaited<ReturnType<typeof createTestDb>>["client"];
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];

  beforeAll(async () => {
    const created = await createTestDb();
    client = created.client;
    db = created.db;
  });

  afterAll(async () => {
    await client.close();
  });

  it("warns on recipe drift and crons that never ran, then clears once seeded and run", async () => {
    const before = await buildConfigReport(baseDeps({ mode: "db", databaseOk: true, db: () => db }));
    expect(before.warnings.map((w) => w.code)).toEqual([
      "recipe_drift",
      "cron_never_ran:stale-jobs",
      "cron_never_ran:purge-source-media",
    ]);
    expect(before.recipes?.drift.every((d) => d.issue === "missing")).toBe(true);

    await loadRecipes(db as unknown as Db, recipeSeedRows);
    await recordCronSuccess(db as unknown as Db, "stale-jobs", new Date(NOW.getTime() - 5 * 60_000));
    await recordCronSuccess(db as unknown as Db, "purge-source-media", new Date(NOW.getTime() - 3 * 24 * 60 * 60_000));
    const after = await buildConfigReport(baseDeps({ mode: "db", databaseOk: true, db: () => db }));
    expect(after.recipes).toEqual({ drift: [] });
    expect(after.warnings.map((w) => w.code)).toEqual(["cron_overdue:purge-source-media"]);
    expect(after.warnings[0].message).toBe(
      "The purge-source-media cron last succeeded 4320 minutes ago. It should run every 1440 minutes.",
    );
  });

  it("skips the reads when the database failed, and turns a failed read into a warning", async () => {
    const execute = vi.fn();
    const skipped = await buildConfigReport(baseDeps({ mode: "db", databaseOk: false, db: () => ({ execute }) }));
    expect(execute).not.toHaveBeenCalled();
    expect(skipped.recipes).toBeNull();

    const warn = vi.fn();
    const failing = await buildConfigReport(
      baseDeps({
        mode: "db",
        databaseOk: true,
        db: () => ({ execute: () => Promise.reject(new Error("relation does not exist")) }),
        logger: { warn },
      }),
    );
    expect(failing.warnings.map((w) => w.code)).toEqual(["recipe_check_failed", "cron_check_failed"]);
    expect(JSON.stringify(failing)).not.toContain("relation does not exist");
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("cachedConfigReport", () => {
  it("reuses a recent report with the same database state and rebuilds otherwise", async () => {
    const cache = createConfigReportCache();
    const build = vi.fn(() => buildConfigReport(baseDeps()));
    await cachedConfigReport(cache, { databaseOk: true, nowMs: 0 }, build);
    await cachedConfigReport(cache, { databaseOk: true, nowMs: 59_000 }, build);
    expect(build).toHaveBeenCalledTimes(1);
    await cachedConfigReport(cache, { databaseOk: false, nowMs: 59_000 }, build);
    await cachedConfigReport(cache, { databaseOk: false, nowMs: 60_000, fresh: true }, build);
    await cachedConfigReport(cache, { databaseOk: false, nowMs: 200_000 }, build);
    expect(build).toHaveBeenCalledTimes(4);
  });
});
