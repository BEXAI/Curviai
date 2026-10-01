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
import { PgCapStore } from "@curvi/trigger/cap-store";
import { LlmMonitor } from "@curvi/trigger/llm-monitor";

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

  it.each([
    [["OPENAI_API_KEY"], false],
    [["ANTHROPIC_API_KEY"], false],
    [["OPENAI_API_KEY", "ANTHROPIC_API_KEY"], false],
    [[], true],
  ])("with LLM keys %j warns about the text stages: %s", async (llmKeys, warns) => {
    const readEnv = keysEnv(["GEMINI_API_KEY", "FAL_KEY", ...llmKeys]);
    const report = await buildConfigReport(baseDeps({ readEnv, providerTargets: liveProviderTargets(readEnv) }));
    const llm = report.warnings.filter((w) => w.code === "no_llm_provider");
    expect(llm).toHaveLength(warns ? 1 : 0);
    for (const stage of report.providerKeys.filter((s) => s.kind === "llm")) {
      expect(stage.ready, stage.stage).toBe(!warns);
    }
    if (warns) {
      // One warning that names each uncovered stage and both keys, never
      // only Anthropic.
      expect(llm[0].message).toBe(
        "No model key is set for the intake, analyze, plan, copy, qc, pick, brand and question stages. Set ANTHROPIC_API_KEY or OPENAI_API_KEY to run them live.",
      );
    }
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

    // The LLM spend read only runs for the detailed report, and a failure
    // there is logged and reported as null, never as a warning.
    const detailedWarn = vi.fn();
    const detailed = await buildConfigReport(
      baseDeps({
        mode: "db",
        databaseOk: true,
        db: () => ({ execute: () => Promise.reject(new Error("relation does not exist")) }),
        logger: { warn: detailedWarn },
        includeLlmSpend: true,
      }),
    );
    expect(detailed.warnings.map((w) => w.code)).toEqual(["recipe_check_failed", "cron_check_failed"]);
    expect(detailed.llmSpend).toBeNull();
    expect(detailedWarn).toHaveBeenCalledTimes(3);
  });

  it("reports LLM spend per provider for the last 7 days from the monitor's counters (PHASE_17 workstream 6)", async () => {
    const store = new PgCapStore(db as unknown as Db);
    const monitor = new LlmMonitor({
      store,
      log: { info: () => {}, error: () => {} },
      now: () => NOW,
    });
    const usage = { inputTokens: 1_000, cachedInputTokens: 600, outputTokens: 400, reasoningTokens: 250 };
    const at = new Date(NOW.getTime() - 2 * 24 * 60 * 60_000);
    const entry = { task: "copy_generator", latencyMs: 1, ok: true, attempt: 1, at, jobId: "job-1", usage };
    await monitor.observe({ ...entry, provider: "openai:gpt-6-luna", costMicros: 300, primaryProvider: "openai:gpt-6-luna" });
    await monitor.observe({ ...entry, provider: "anthropic:claude-haiku-4-5-20251001", costMicros: 3_000, primaryProvider: "openai:gpt-6-luna" });
    // Eight days back is outside the report.
    await monitor.observe({ ...entry, at: new Date(NOW.getTime() - 8 * 24 * 60 * 60_000), provider: "openai:gpt-6-luna", costMicros: 999 });

    const publicReport = await buildConfigReport(baseDeps({ mode: "db", databaseOk: true, db: () => db }));
    expect(publicReport.llmSpend).toBeNull();

    const report = await buildConfigReport(baseDeps({ mode: "db", databaseOk: true, db: () => db, includeLlmSpend: true }));
    expect(report.llmSpend?.days).toHaveLength(7);
    expect(report.llmSpend?.byFamily.openai).toMatchObject({ calls: 1, costMicros: 300, cachedInputTokens: 600, reasoningTokens: 250 });
    expect(report.llmSpend?.byFamily.anthropic).toMatchObject({ calls: 1, costMicros: 3_000 });
    expect(report.llmSpend?.totalMicros).toBe(3_300);
  });
});

describe("OpenAI credit expiry warning (founder decision 4)", () => {
  const at = (iso: string) => baseDeps({ now: () => new Date(iso) });

  it("stays quiet before the first seeded reminder", async () => {
    expect((await buildConfigReport(at("2026-11-30T23:59:00Z"))).warnings).toEqual([]);
  });

  it("warns from 2026-12-01 until the credits expire, then says they expired", async () => {
    const first = await buildConfigReport(at("2026-12-01T08:00:00Z"));
    expect(first.warnings).toEqual([
      {
        code: "llm_credits_expiring:openai",
        message:
          "The OpenAI credits expire on 2026-12-31, in 30 days. Decide whether to keep OpenAI on paid usage or make Claude the primary model again.",
      },
    ]);
    expect((await buildConfigReport(at("2026-12-31T08:00:00Z"))).warnings[0].message).toContain("2026-12-31, today.");
    const after = await buildConfigReport(at("2027-01-01T08:00:00Z"));
    expect(after.warnings.map((w) => w.code)).toEqual(["llm_credits_expired:openai"]);
    for (const w of [...first.warnings, ...after.warnings]) {
      expect(w.message).not.toMatch(/ - | – | — |->|→/);
    }
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
