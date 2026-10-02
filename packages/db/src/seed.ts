import { sql } from "drizzle-orm";
import { loadRegistry } from "@curvi/specs";
import type { Db } from "./client";
import { channelSpecs, disposableEmailDomains, recipes } from "./schema";

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

/** Synchronize the vetted domain snapshot atomically. Removed upstream
 * domains stop withholding credits; an empty or malformed input cannot
 * erase the list. The seed CLI verifies the pinned digest before calling. */
export async function loadDisposableEmailDomains(
  db: Db,
  domains: readonly string[],
  options: { batchSize: number },
): Promise<number> {
  if (domains.length === 0) throw new Error("Disposable domain seed must not be empty");
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1) {
    throw new Error("Disposable domain batch size must be a positive integer");
  }
  const validDomain = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (domains.some((domain) => domain.length > 253 || !validDomain.test(domain))) {
    throw new Error("Disposable domain seed contains an invalid domain");
  }
  const unique = [...new Set(domains)];
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('curvi:disposable-domain-seed', 0))`);
    for (let offset = 0; offset < unique.length; offset += options.batchSize) {
      await tx.insert(disposableEmailDomains)
        .values(unique.slice(offset, offset + options.batchSize).map((domain) => ({ domain })))
        .onConflictDoNothing();
    }
    // One JSON parameter avoids PostgreSQL's bind limit as the list grows.
    await tx.delete(disposableEmailDomains).where(sql`NOT (${disposableEmailDomains.domain} = ANY (
      ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(unique)}::jsonb))
    ))`);
  });
  return unique.length;
}
