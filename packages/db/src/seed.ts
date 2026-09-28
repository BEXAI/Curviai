import { sql } from "drizzle-orm";
import { loadRegistry } from "@curvi/specs";
import type { Db } from "./client";
import { channelSpecs, recipes } from "./schema";

/**
 * Upsert every entry from the @curvi/specs registry into channel_specs.
 * Idempotent: rerunning updates rows in place and never duplicates.
 * Returns the number of specs written.
 */
export async function loadChannelSpecs(db: Db): Promise<number> {
  const registry = loadRegistry();
  const now = new Date();
  const rows = registry.specs.map((spec) => ({
    id: spec.id,
    version: registry.version,
    spec: spec as Record<string, unknown>,
    updatedAt: now,
  }));
  await db
    .insert(channelSpecs)
    .values(rows)
    .onConflictDoUpdate({
      target: channelSpecs.id,
      set: {
        version: sql`excluded.version`,
        spec: sql`excluded.spec`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
  return rows.length;
}

/** One recipe seed row. Prompt bodies and model ids live in seed data, never in logic code. */
export interface RecipeSeedRow {
  key: string;
  version: number;
  stage: string;
  model: string;
  fallbackModels?: string[];
  body: Record<string, unknown>;
  active: boolean;
  trafficPct?: number;
}

/**
 * Upsert recipe seed rows keyed on (key, version).
 * Returns the number of rows written.
 */
export async function loadRecipes(db: Db, rows: RecipeSeedRow[]): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  await db
    .insert(recipes)
    .values(
      rows.map((row) => ({
        key: row.key,
        version: row.version,
        stage: row.stage,
        model: row.model,
        fallbackModels: row.fallbackModels ?? [],
        body: row.body,
        active: row.active,
        trafficPct: row.trafficPct ?? 100,
      })),
    )
    .onConflictDoUpdate({
      target: [recipes.key, recipes.version],
      set: {
        stage: sql`excluded.stage`,
        model: sql`excluded.model`,
        fallbackModels: sql`excluded.fallback_models`,
        body: sql`excluded.body`,
        active: sql`excluded.active`,
        trafficPct: sql`excluded.traffic_pct`,
      },
    });
  return rows.length;
}
