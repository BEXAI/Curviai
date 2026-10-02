import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@curvi/db/testing";
import { loadRecipes, sql, type Db } from "@curvi/db";
import { recipeSeedRows } from "@curvi/pipeline/seed";
import { buildConfigReport, type ConfigReportDeps } from "./config-health";
import { classify } from "./health-status";

const fixture = { model: "retiring-fixture", earliestRetirementDate: "2026-10-15", dateKind: "not-sooner-than" as const,
  source: "https://platform.claude.com/docs/en/about-claude/model-deprecations", checkedOn: "2026-10-02" };
const base: ConfigReportDeps = { mode: "demo", databaseOk: false, readEnv: () => undefined, storageConfigured: true,
  providerTargets: [], seedRecipes: [{ key: "fixture", version: 1, active: true, trafficPct: 0, model: "safe",
    fallbackModels: [], body: { escalation: [fixture.model] } }],
  readTextFile: () => null, rssBytes: () => 0, modelRetirements: [fixture] };

describe("retirement health warnings", () => {
  it("emits an informational early notice and a degraded 10-day notice without asserting a shutdown", async () => {
    const early = await buildConfigReport({ ...base, now: () => new Date("2026-09-15T23:00:00Z") });
    const info = early.warnings.find((warning) => warning.code.startsWith("llm_model_retiring:"));
    expect(info).toMatchObject({ code: "llm_model_retiring:retiring-fixture", severity: "info" });
    const urgent = await buildConfigReport({ ...base, now: () => new Date("2026-10-05T00:00:00Z") });
    const warning = urgent.warnings.find((entry) => entry.code.startsWith("llm_model_retiring:"))!;
    expect(warning.severity).toBe("degraded");
    expect(warning.message).toContain("not an announced shutdown");
    expect(classify([warning.code])).toEqual({ status: "degraded", degradedBy: [warning.code] });
  });

  let client: Awaited<ReturnType<typeof createTestDb>>["client"];
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  beforeAll(async () => { ({ client, db } = await createTestDb()); });
  afterAll(async () => { await client.close(); });

  it("checks the active database chains and exposes production/seed traffic differences", async () => {
    await loadRecipes(db as unknown as Db, recipeSeedRows);
    await db.execute(sql`update recipes set fallback_models = ${JSON.stringify([fixture.model])}::jsonb, traffic_pct = 50 where key = 'shot_planner' and version = 3`);
    const report = await buildConfigReport({ ...base, mode: "db", databaseOk: true, db: () => db,
      seedRecipes: recipeSeedRows, now: () => new Date("2026-10-05T00:00:00Z") });
    expect(report.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "recipe_drift" }),
      expect.objectContaining({ code: "llm_model_retiring:retiring-fixture", severity: "degraded" }),
    ]));
    expect(report.recipes?.drift).toContainEqual({ key: "shot_planner", version: 3, issue: "traffic_pct", expected: "100", actual: "50" });
  });
});
