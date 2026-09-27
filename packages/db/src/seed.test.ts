import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import { loadRegistry } from "@curvi/specs";
import { createTestDb, type TestDb } from "./test-helpers";
import { loadChannelSpecs, loadRecipes } from "./seed";
import type { Db } from "./client";
import { channelSpecs, recipes } from "./schema";

let client: PGlite;
let db: TestDb;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
});

afterAll(async () => {
  await client.close();
});

describe("loadChannelSpecs", () => {
  it("writes all 18 registry specs", async () => {
    const written = await loadChannelSpecs(db as unknown as Db);
    expect(written).toBe(18);
    const rows = await db.select().from(channelSpecs);
    expect(rows).toHaveLength(18);
    const ids = rows.map((r) => r.id).sort();
    const registryIds = loadRegistry()
      .specs.map((s) => s.id)
      .sort();
    expect(ids).toEqual(registryIds);
  });

  it("is idempotent on a second run", async () => {
    const written = await loadChannelSpecs(db as unknown as Db);
    expect(written).toBe(18);
    const rows = await db.select().from(channelSpecs);
    expect(rows).toHaveLength(18);
    const [main] = await db
      .select()
      .from(channelSpecs)
      .where(eq(channelSpecs.id, "amazon.main"));
    expect(main.version).toBe(loadRegistry().version);
    expect((main.spec as { id?: string }).id).toBe("amazon.main");
  });
});

describe("loadRecipes", () => {
  const seedRows = [
    {
      key: "intake_normalizer",
      version: 1,
      stage: "intake",
      model: "model-a",
      body: { system: "normalize the intake" },
      active: true,
    },
    {
      key: "shot_planner",
      version: 1,
      stage: "planning",
      model: "model-b",
      body: { system: "plan the shots" },
      active: false,
    },
  ];

  it("inserts recipe seed rows", async () => {
    const written = await loadRecipes(db as unknown as Db, seedRows);
    expect(written).toBe(2);
    const rows = await db.select().from(recipes);
    expect(rows).toHaveLength(2);
    const intake = rows.find((r) => r.key === "intake_normalizer");
    expect(intake?.model).toBe("model-a");
    expect(intake?.trafficPct).toBe(100);
    expect(intake?.active).toBe(true);
  });

  it("upserts on key and version without duplicating", async () => {
    await loadRecipes(db as unknown as Db, [
      { ...seedRows[0], model: "model-a2", active: false },
    ]);
    const rows = await db.select().from(recipes);
    expect(rows).toHaveLength(2);
    const intake = rows.find((r) => r.key === "intake_normalizer");
    expect(intake?.model).toBe("model-a2");
    expect(intake?.active).toBe(false);
  });

  it("returns zero for an empty seed list", async () => {
    expect(await loadRecipes(db as unknown as Db, [])).toBe(0);
  });
});
