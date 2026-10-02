import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@curvi/db";
import { createTestDb } from "@curvi/db/testing";
import { recipeSeedRows } from "@curvi/pipeline/seed";
import { liveProviderTargets } from "@curvi/trigger/provider-probes";
import { buildConfigReport, type ConfigReportDeps } from "./config-health";

// P18-03 health additions: fal_admin_key_missing when a fal inference key is
// set without the Admin API key that reads its balance, and the newest
// balance per account in the detailed report only.

const NOW = new Date("2026-10-01T12:00:00Z");

function deps(env: Record<string, string>, overrides: Partial<ConfigReportDeps> = {}): ConfigReportDeps {
  const readEnv = (name: string) => env[name] || undefined;
  return {
    mode: "demo",
    databaseOk: true,
    readEnv,
    storageConfigured: true,
    providerTargets: liveProviderTargets(readEnv),
    seedRecipes: recipeSeedRows,
    readTextFile: () => null,
    rssBytes: () => 1,
    now: () => NOW,
    ...overrides,
  };
}

const codes = async (env: Record<string, string>) =>
  (await buildConfigReport(deps(env))).warnings.map((w) => w.code).filter((c) => c.startsWith("fal_"));

describe("fal_admin_key_missing", () => {
  it("warns when FAL_KEY is set without FAL_ADMIN_KEY, naming both, never their values", async () => {
    const report = await buildConfigReport(deps({ FAL_KEY: "secret-fal-key" }));
    const warning = report.warnings.find((w) => w.code === "fal_admin_key_missing");
    expect(warning?.message).toBe(
      "FAL_KEY is set without FAL_ADMIN_KEY, so that fal balance is never checked and no low balance email can go out.",
    );
    expect(JSON.stringify(report.warnings)).not.toContain("secret-fal-key");
  });

  it("covers the backup account too, and is quiet once each admin key is set", async () => {
    expect(await codes({ FAL_KEY: "a", FAL_KEY_BACKUP: "b", FAL_ADMIN_KEY: "c" })).toEqual(["fal_admin_key_missing"]);
    expect(await codes({ FAL_KEY: "a", FAL_ADMIN_KEY: "c" })).toEqual([]);
    expect(await codes({ FAL_KEY: "a", FAL_KEY_BACKUP: "b", FAL_ADMIN_KEY: "c", FAL_ADMIN_KEY_BACKUP: "d" })).toEqual([]);
    // No fal key at all is the no_cutout_provider warning's job.
    expect(await codes({})).toEqual([]);
  });
});

describe("fal balances in the detailed report", () => {
  let created: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    created = await createTestDb();
    await created.db.execute(
      sql`insert into platform_settings (key, value) values ('fal_balance:fal-birefnet', ${JSON.stringify({
        ok: true,
        balanceUsd: 4.2,
        currency: "USD",
        balanceAt: NOW.toISOString(),
        checkedAt: NOW.toISOString(),
      })}::jsonb)`,
    );
  });

  afterAll(async () => {
    await created.client.close();
  });

  it("shows the newest reading per account when detailed, and nothing on the public check", async () => {
    const env = { FAL_KEY: "a", FAL_ADMIN_KEY: "b" };
    const detailed = await buildConfigReport(deps(env, { mode: "db", db: () => created.db, includeLlmSpend: true }));
    expect(detailed.falBalances).toEqual([
      expect.objectContaining({ provider: "fal-birefnet", balanceUsd: 4.2, ok: true, balanceAt: NOW.toISOString() }),
    ]);
    const publicReport = await buildConfigReport(deps(env, { mode: "db", db: () => created.db }));
    expect(publicReport.falBalances).toBeNull();
  });
});
