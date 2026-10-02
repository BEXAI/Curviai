/**
 * Recipe drift: the active rows of the recipes table against the compiled
 * seed (packages/pipeline/src/seed/recipes.ts). The worker reads prompts and
 * models from the table first (trigger/src/recipes.ts), so any difference
 * means production runs other prompts or models than the code in this
 * build. Each row is compared on key, version, model, fallback models,
 * active flag, traffic percentage and a hash of its body; the report carries hashes and model
 * ids, never prompt text.
 */

import { createHash } from "node:crypto";
import { sql } from "@curvi/db";
import { canonicalJson } from "@curvi/pipeline/output-options";
import type { SqlExecutor } from "@/lib/service-health";

export interface RecipeLike {
  key: string;
  version: number;
  model: string;
  fallbackModels?: readonly string[] | null;
  body: unknown;
  active: boolean;
  trafficPct?: number | null;
}

export type RecipeDriftIssue =
  /** An active seed row has no row in the table. */
  | "missing"
  /** An active seed row is inactive in the table. */
  | "inactive"
  /** A table row is active but the seed has it inactive or not at all. */
  | "unexpected_active"
  | "model"
  | "fallback_models"
  | "traffic_pct"
  | "body";

export interface RecipeDrift {
  key: string;
  version: number;
  issue: RecipeDriftIssue;
  /** Seed side: a model id, the fallback list, or a body hash. */
  expected?: string;
  /** Table side, in the same form. */
  actual?: string;
}

/** Short sha256 of a recipe body in canonical form (keys sorted at every
 * level, so a jsonb round trip hashes the same as the seed object). */
export function recipeBodyHash(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex").slice(0, 16);
}

function rowId(row: { key: string; version: number }): string {
  return `${row.key}@${row.version}`;
}

function fallbackText(models: readonly string[] | null | undefined): string {
  return (models ?? []).join(", ");
}

/** Every difference between the table and the seed, in seed order first. */
export function compareRecipes(tableRows: readonly RecipeLike[], seedRows: readonly RecipeLike[]): RecipeDrift[] {
  const drift: RecipeDrift[] = [];
  const table = new Map(tableRows.map((row) => [rowId(row), row]));
  const seed = new Map(seedRows.map((row) => [rowId(row), row]));

  for (const expected of seedRows) {
    const where = { key: expected.key, version: expected.version };
    const actual = table.get(rowId(expected));
    if (!actual) {
      if (expected.active) drift.push({ ...where, issue: "missing" });
      continue;
    }
    if (actual.active !== expected.active) {
      drift.push({ ...where, issue: expected.active ? "inactive" : "unexpected_active", expected: String(expected.active), actual: String(actual.active) });
    }
    const expectedTraffic = expected.trafficPct ?? 100;
    const actualTraffic = actual.trafficPct ?? 100;
    if (actualTraffic !== expectedTraffic) {
      drift.push({ ...where, issue: "traffic_pct", expected: String(expectedTraffic), actual: String(actualTraffic) });
    }
    if (!expected.active || !actual.active) continue;
    if (actual.model !== expected.model) {
      drift.push({ ...where, issue: "model", expected: expected.model, actual: actual.model });
    }
    const expectedFallbacks = fallbackText(expected.fallbackModels);
    const actualFallbacks = fallbackText(actual.fallbackModels);
    if (expectedFallbacks !== actualFallbacks) {
      drift.push({ ...where, issue: "fallback_models", expected: expectedFallbacks, actual: actualFallbacks });
    }
    const expectedHash = recipeBodyHash(expected.body);
    const actualHash = recipeBodyHash(actual.body);
    if (expectedHash !== actualHash) {
      drift.push({ ...where, issue: "body", expected: expectedHash, actual: actualHash });
    }
  }

  for (const actual of tableRows) {
    if (!actual.active) continue;
    if (!seed.has(rowId(actual))) {
      drift.push({ key: actual.key, version: actual.version, issue: "unexpected_active", actual: actual.model });
    }
  }
  return drift;
}

interface RecipeDbRow {
  key: string;
  version: number | string;
  model: string;
  fallback_models: unknown;
  body: unknown;
  active: boolean | string;
  traffic_pct?: number | string | null;
}

/** postgres-js returns the rows as an array, PGlite as { rows }. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    return result as T[];
  }
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}

/** jsonb arrives parsed from both drivers; a text form is parsed here. */
function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** Every row of the recipes table, in the comparable shape. */
export async function readRecipeRows(db: SqlExecutor): Promise<RecipeLike[]> {
  const rows = rowsOf<RecipeDbRow>(
    await db.execute(sql`select key, version, model, fallback_models, body, active, traffic_pct from recipes`),
  );
  return rows.map((row) => {
    const fallbacks = parseJson(row.fallback_models);
    return {
      key: row.key,
      version: Number(row.version),
      model: row.model,
      fallbackModels: Array.isArray(fallbacks) ? fallbacks.filter((m): m is string => typeof m === "string") : [],
      body: parseJson(row.body),
      active: row.active === true || row.active === "t" || row.active === "true",
      trafficPct: row.traffic_pct == null ? 100 : Number(row.traffic_pct),
    };
  });
}
