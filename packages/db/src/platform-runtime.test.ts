import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import type { Db } from "./client";
import { generationJobs, products, recipes, workspaces } from "./schema";
import { loadRecipes } from "./seed";
import { createTestDb, type TestDb } from "./test-helpers";

// Migration 0017: recipe failover models, the per job recipe assignment and
// the (status, updated_at) index the stale job sweep reads.

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

describe("migration 0017", () => {
  it("defaults fallback_models to an empty list and stores the seeded order", async () => {
    await client.query(
      `insert into recipes (key, version, stage, model, body, active)
       values ('legacy_row', 1, 'qc', 'model-a', '{"system":"judge"}', true)`,
    );
    const [legacy] = await db.select().from(recipes).where(eq(recipes.key, "legacy_row"));
    expect(legacy.fallbackModels).toEqual([]);

    await loadRecipes(db as unknown as Db, [
      {
        key: "with_fallback",
        version: 1,
        stage: "plan",
        model: "model-a",
        fallbackModels: ["model-b", "model-c"],
        body: { system: "plan" },
        active: true,
        trafficPct: 30,
      },
    ]);
    const [row] = await db.select().from(recipes).where(eq(recipes.key, "with_fallback"));
    expect(row.fallbackModels).toEqual(["model-b", "model-c"]);
    expect(row.trafficPct).toBe(30);

    // A reseed swaps the order in place.
    await loadRecipes(db as unknown as Db, [
      { key: "with_fallback", version: 1, stage: "plan", model: "model-c", fallbackModels: ["model-a"], body: { system: "plan" }, active: true },
    ]);
    const [swapped] = await db.select().from(recipes).where(eq(recipes.key, "with_fallback"));
    expect(swapped.model).toBe("model-c");
    expect(swapped.fallbackModels).toEqual(["model-a"]);
  });

  it("records the recipe variants a job ran on", async () => {
    const [ws] = await db.insert(workspaces).values({ name: "W" }).returning();
    const [product] = await db.insert(products).values({ workspaceId: ws.id, title: "Mug", mode: "listing" }).returning();
    const [job] = await db.insert(generationJobs).values({ workspaceId: ws.id, productId: product.id }).returning();
    expect(job.recipeVariants).toBeNull();
    await db
      .update(generationJobs)
      .set({ recipeVariants: { shot_planner: { recipeId: null, version: 2, source: "seed" } } })
      .where(eq(generationJobs.id, job.id));
    const [saved] = await db.select().from(generationJobs).where(eq(generationJobs.id, job.id));
    expect(saved.recipeVariants).toEqual({ shot_planner: { recipeId: null, version: 2, source: "seed" } });
  });

  it("indexes generation_jobs on (status, updated_at)", async () => {
    const result = await client.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where indexname = 'generation_jobs_status_updated_at_idx'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].indexdef).toContain("(status, updated_at)");
  });
});
