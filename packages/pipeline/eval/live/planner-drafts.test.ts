import { beforeAll, describe, expect, it } from "vitest";
import { recipeSeedRows } from "../../src/seed/recipes";
import { goldenCases, jewelryPlanIssues, marketplacePlanIssues } from "./cases";
import { recipeReport, runCase, runLiveEval, selectRecipes, type GoldenCase } from "./harness";
import type { LlmCaller } from "./callers";

let cases: GoldenCase[];
beforeAll(async () => { cases = await goldenCases(); });

const shot = (overrides: Record<string, unknown> = {}) => ({
  id: "s1", type: "lifestyle", sourceMediaId: "golden/front.jpg", method: "composite_generate",
  channels: ["shopify.product"], stylePreset: "minimal_studio", scene: "detail macro", credits: 1, priority: 1,
  ...overrides,
});
const jewelry = { shots: [shot(), shot({ id: "s2", scene: "scale next to a familiar object" })], skipped: [] };
const marketplaces = {
  shots: ["etsy.listing", "ebay.listing", "walmart.main", "tiktokshop.main", "pinterest.pin"].map((channel, index) => shot({
    id: `s${index}`, channels: [channel], method: "deterministic", type: channel === "pinterest.pin" ? "social_2x3" : "alt_angle_white",
  })),
  skipped: [],
};
function caller(answer: unknown): LlmCaller {
  return { provider: "openai", call: async () => ({ ok: true, costMicros: 0, latencyMs: 1,
    result: { json: answer, text: "", finish: "complete", raw: null,
      usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0 } },
  }) };
}
const selected = (version: number) => selectRecipes(recipeSeedRows, "openai", { only: [`shot_planner@${version}`] }).selected[0];

describe("inactive planner draft gates", () => {
  it("uses v3 by default and requires an explicit version to evaluate a draft", () => {
    expect(selectRecipes(recipeSeedRows, "openai").selected.find((r) => r.row.key === "shot_planner")?.row.version).toBe(3);
    expect(selected(4).row).toMatchObject({ version: 4, active: false, trafficPct: 0 });
    expect(selected(5).row).toMatchObject({ version: 5, active: false, trafficPct: 0 });
  });

  it("rejects hand scale, missing detail, and invented source media", () => {
    expect(jewelryPlanIssues(jewelry)).toEqual([]);
    expect(jewelryPlanIssues({ shots: [shot({ scene: "scale on hand", sourceMediaId: "invented.jpg" })] })).toEqual([
      "Plan uses an unsupplied source photo.", "Jewelry detail scene missing.", "Object scale scene missing.",
      "Jewelry plan adds an unphotographed body scene.",
    ]);
  });

  it("requires all five exact channels and deterministic marketplace mains", () => {
    expect(marketplacePlanIssues(marketplaces)).toEqual([]);
    const bad = { shots: [shot({ channels: ["walmart.main", "made-up.channel"] })] };
    expect(marketplacePlanIssues(bad)).toContain("Missing selected channel etsy.listing.");
    expect(marketplacePlanIssues(bad)).toContain("Plan adds an unselected or unknown channel.");
    expect(marketplacePlanIssues(bad)).toContain("walmart.main must use the deterministic supplied product image.");
    expect(marketplacePlanIssues({ shots: [shot({ channels: ["pinterest.pin"] })] }))
      .toContain("Pinterest must use the registered social_2x3 format.");
  });

  it("fails the semantic gate even when a draft answer passes its JSON schema", async () => {
    const fixture = cases.find((c) => c.id === "plan_mug_five_marketplaces")!;
    const bad = await runCase(caller(jewelry), selected(5), fixture);
    expect(bad.schemaPass).toBe(true);
    expect(bad.semanticIssues?.length).toBeGreaterThan(0);
    expect(recipeReport(selected(5), [bad], null).bar).toEqual([
      expect.objectContaining({ name: "plan_mug_five_marketplaces semantic checks", pass: false }),
    ]);
    const good = await runCase(caller(marketplaces), selected(5), fixture);
    expect(good.schemaPass).toBe(true);
    expect(good.semanticIssues).toEqual([]);
  });

  it("does not retroactively change older baseline cases or let fixture failures disappear", async () => {
    const draftCases = cases.filter((c) => c.minRecipeVersion !== undefined);
    const old = await runLiveEval({ caller: caller(jewelry), rows: recipeSeedRows, only: ["shot_planner@3"],
      cases: draftCases, injection: [], baseline: null });
    expect(old.cases).toHaveLength(0);
    const draft = await runLiveEval({ caller: caller(jewelry), rows: recipeSeedRows, only: ["shot_planner@5"],
      cases: draftCases, injection: [], baseline: null });
    expect(draft.cases.map((c) => c.caseId)).toEqual(["plan_jewelry_object_scale", "plan_mug_five_marketplaces"]);
    expect(draft.failures.some((failure) => failure.includes("plan_mug_five_marketplaces semantic checks"))).toBe(true);
  });
});
