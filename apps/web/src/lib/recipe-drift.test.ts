import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRecipes, recipes, sql, type Db } from "@curvi/db";
import { createTestDb } from "@curvi/db/testing";
import { canonicalJson } from "@curvi/pipeline/output-options";
import { recipeSeedRows } from "@curvi/pipeline/seed";
import { compareRecipes, readRecipeRows, recipeBodyHash, type RecipeLike } from "./recipe-drift";

const seed: RecipeLike[] = [
  { key: "a", version: 1, model: "m1", fallbackModels: ["m2"], body: { system: "one", maxTokens: 10 }, active: true },
  { key: "b", version: 1, model: "m1", body: { system: "two" }, active: true },
  { key: "old", version: 1, model: "m0", body: { system: "retired" }, active: false },
];

describe("canonicalJson and recipeBodyHash", () => {
  it("ignores key order and undefined values, as a jsonb round trip does", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, "x"], c: null } })).toBe('{"a":{"c":null,"d":[1,"x"]},"b":1}');
    expect(recipeBodyHash({ system: "s", maxTokens: 5, extra: undefined })).toBe(recipeBodyHash({ maxTokens: 5, system: "s" }));
    expect(recipeBodyHash({ system: "s" })).not.toBe(recipeBodyHash({ system: "s " }));
    expect(recipeBodyHash({ system: "s" })).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("compareRecipes", () => {
  it("finds nothing when the table matches the seed", () => {
    const table = seed.map((row) => ({ ...row, fallbackModels: row.fallbackModels ?? [], body: { ...row.body as object } }));
    expect(compareRecipes(table, seed)).toEqual([]);
  });

  it("reports a missing, inactive, changed and unexpected row without prompt text", () => {
    const table: RecipeLike[] = [
      { key: "a", version: 1, model: "m9", fallbackModels: [], body: { system: "one edited", maxTokens: 10 }, active: true },
      { key: "b", version: 1, model: "m1", fallbackModels: [], body: { system: "two" }, active: false },
      { key: "old", version: 1, model: "m0", fallbackModels: [], body: { system: "retired" }, active: true },
      { key: "c", version: 2, model: "m3", fallbackModels: [], body: { system: "new" }, active: true },
    ];
    const drift = compareRecipes(table, seed);
    expect(drift.map((d) => [d.key, d.issue])).toEqual([
      ["a", "model"],
      ["a", "fallback_models"],
      ["a", "body"],
      ["b", "inactive"],
      ["old", "unexpected_active"],
      ["c", "unexpected_active"],
    ]);
    expect(drift[0]).toMatchObject({ expected: "m1", actual: "m9" });
    expect(drift[1]).toMatchObject({ expected: "m2", actual: "" });
    expect(JSON.stringify(drift)).not.toContain("one edited");
    expect(compareRecipes([], seed).map((d) => d.issue)).toEqual(["missing", "missing"]);
  });

  it("reports both percentages and active states per version, including rollback and inactive rows", () => {
    const expected = [
      { ...seed[0], trafficPct: 100 },
      { ...seed[0], version: 2, trafficPct: 0 },
      { ...seed[0], version: 3, active: false, trafficPct: 0 },
    ];
    const actual = [
      { ...expected[0], trafficPct: 50 },
      { ...expected[1], active: false, trafficPct: 50 },
      { ...expected[2], active: true, trafficPct: 10 },
    ];
    expect(compareRecipes(actual, expected)).toEqual([
      { key: "a", version: 1, issue: "traffic_pct", expected: "100", actual: "50" },
      { key: "a", version: 2, issue: "inactive", expected: "true", actual: "false" },
      { key: "a", version: 2, issue: "traffic_pct", expected: "0", actual: "50" },
      { key: "a", version: 3, issue: "unexpected_active", expected: "false", actual: "true" },
      { key: "a", version: 3, issue: "traffic_pct", expected: "0", actual: "10" },
    ]);
    expect(compareRecipes([{ ...seed[0], trafficPct: 100 }], [seed[0]])).toEqual([]);
    expect(compareRecipes([{ ...expected[2], trafficPct: 20 }], [expected[2]]))
      .toEqual([{ key: "a", version: 3, issue: "traffic_pct", expected: "0", actual: "20" }]);
  });
});

describe("readRecipeRows against the real schema", () => {
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

  it("matches the compiled seed after pnpm db:seed, and catches an edited row", async () => {
    await loadRecipes(db as unknown as Db, recipeSeedRows);
    expect(compareRecipes(await readRecipeRows(db), recipeSeedRows)).toEqual([]);

    const active = recipeSeedRows.find((row) => row.active)!;
    await db.execute(sql`update ${recipes} set model = 'swapped-model' where key = ${active.key} and version = ${active.version}`);
    const drift = compareRecipes(await readRecipeRows(db), recipeSeedRows);
    expect(drift).toEqual([
      { key: active.key, version: active.version, issue: "model", expected: active.model, actual: "swapped-model" },
    ]);
  });

  it("reads the production traffic percentage instead of silently defaulting it", async () => {
    await loadRecipes(db as unknown as Db, recipeSeedRows);
    await db.execute(sql`update ${recipes} set traffic_pct = 50 where key = 'shot_planner' and version = 3`);
    const drift = compareRecipes(await readRecipeRows(db), recipeSeedRows);
    expect(drift).toEqual([{ key: "shot_planner", version: 3, issue: "traffic_pct", expected: "100", actual: "50" }]);
  });
});
