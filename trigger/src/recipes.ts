/**
 * Runtime recipes (docs/PENDING.md, Trust and platform). The worker reads the
 * active rows of the recipes table instead of the compiled seed, so a prompt,
 * a model swap or an A/B test is a row update rather than a deploy
 * (CLAUDE.md rule 2 keeps prompts and model ids in that table).
 *
 * A/B splits: every active version of a recipe key is a variant, weighted by
 * traffic_pct. A job is assigned one variant per key from a hash of its id,
 * so the pack task and every shot subtask agree without talking to each
 * other, and the assignment is recorded on the job (recipe_variants).
 *
 * Model failover: a recipe's model followed by its fallback_models is the
 * failover chain. Each model is one registered LLM provider (see
 * llmModelProviderName), and the chain is handed to callWithFailover as a per
 * call override, so @curvi/ai walks it with its usual timeout, retry, breaker
 * and metering (CLAUDE.md rule 4).
 *
 * Seed fallback: the table is read at most once per cache window. When a
 * read fails the last good rows keep serving; with none, or for a stage with
 * no usable row, the compiled seed from @curvi/pipeline/seed runs, so a
 * database blip never stops a pack.
 */

import { createHash } from "node:crypto";
import { eq, recipes, type Db, type JobRecipeVariant } from "@curvi/db";
import {
  llmModelProviders,
  RecipeRow,
  recipeSeedRows,
  servingRecipeSeedRow,
  type RecipeModelOptions,
} from "@curvi/pipeline/seed";

export type RecipeStage = RecipeRow["stage"];

/** One recipe version as the worker runs it. */
export interface ResolvedRecipe {
  key: string;
  stage: RecipeStage;
  version: number;
  /** recipes.id, or null for a compiled seed row. */
  recipeId: string | null;
  source: "db" | "seed";
  /** Failover order, primary model first, without duplicates. */
  models: string[];
  system: string;
  /** Output token budget from the recipe body, when it sets one. */
  maxTokens?: number;
  /** Reasoning effort per model id, from the recipe body. */
  modelOptions?: Record<string, RecipeModelOptions>;
  /** Per attempt provider timeout from the recipe body. */
  timeoutMs?: number;
  /** Image detail for the call's image blocks, from the recipe body. */
  imageDetail?: "low" | "high";
  /** A/B weight among the active versions of the key. */
  trafficPct: number;
}

/** The recipe each stage of one job runs on. Plain JSON, since it rides the
 * shot subtask payload along with the rest of the ShotContext. */
export type JobRecipes = Partial<Record<RecipeStage, ResolvedRecipe>>;

/** Anything that assigns a job its recipes; RecipeCatalog in production. */
export interface RecipeResolver {
  forJob(jobId: string): Promise<JobRecipes>;
  /** The recipes a job already ran on, from its recorded recipe_variants,
   * so a pack follow up judges with the same versions as its first run. */
  forVariants?(jobId: string, variants: Record<string, JobRecipeVariant>): Promise<JobRecipes>;
}

/** Registry name of the LLM provider that runs one model,
 * "<provider>:<model>" with the provider from the llmModelProviders seed. The
 * live wiring registers one per priced model; recipes name models, never
 * providers. A model with no provider in the seed fails closed: it gets a
 * name no provider is registered under, so a chain skips it, as it skips an
 * unpriced model. */
export function llmModelProviderName(model: string): string {
  const provider = Object.hasOwn(llmModelProviders, model) ? llmModelProviders[model] : undefined;
  return provider ? `${provider}:${model}` : `unmapped:${model}`;
}

/**
 * The OpenAI price table for a seeded LLM price row, or undefined when the
 * row has no cached input price. The OpenAI adapter bills cached input at
 * its own rate, so a row without one is never wired (fail closed).
 */
export function openaiLlmPriceTable(row: {
  inputMicrosPerMTok: number;
  cachedInputMicrosPerMTok?: number;
  outputMicrosPerMTok: number;
}): { inputMicrosPerMTok: number; cachedInputMicrosPerMTok: number; outputMicrosPerMTok: number } | undefined {
  if (row.cachedInputMicrosPerMTok === undefined) return undefined;
  return {
    inputMicrosPerMTok: row.inputMicrosPerMTok,
    cachedInputMicrosPerMTok: row.cachedInputMicrosPerMTok,
    outputMicrosPerMTok: row.outputMicrosPerMTok,
  };
}

function uniqueModels(models: readonly string[]): string[] {
  return [...new Set(models.filter((m) => m.length > 0))];
}

function fromSeed(row: RecipeRow): ResolvedRecipe {
  return {
    key: row.key,
    stage: row.stage,
    version: row.version,
    recipeId: null,
    source: "seed",
    models: uniqueModels([row.model, ...(row.fallbackModels ?? [])]),
    system: row.body.system,
    ...(typeof row.body.maxTokens === "number" ? { maxTokens: row.body.maxTokens } : {}),
    ...(row.body.modelOptions ? { modelOptions: row.body.modelOptions } : {}),
    ...(typeof row.body.timeoutMs === "number" ? { timeoutMs: row.body.timeoutMs } : {}),
    ...(row.body.imageDetail ? { imageDetail: row.body.imageDetail } : {}),
    trafficPct: row.trafficPct ?? 100,
  };
}

/** The compiled seed recipe for a stage. Throws when the seed has none, a
 * build mistake the seed tests catch. */
export function seedRecipe(stage: RecipeStage): ResolvedRecipe {
  const row = servingRecipeSeedRow(stage);
  if (!row) {
    throw new Error(`No active recipe seeded for stage "${stage}"`);
  }
  return fromSeed(row);
}

/**
 * The other active seed versions of a recipe's key and stage, newest first:
 * the canary rows (trafficPct 0 included) the live wiring appends to the
 * key's routing chain (live-runtime.ts wireLiveProviders). When none of a
 * job's own models has a key set, the runner runs the call on the first of
 * these whose models do, with that version's prompt, budget, efforts and
 * image detail, so a model never gets a body written for another provider.
 */
export function standbySeedRecipes(recipe: Pick<ResolvedRecipe, "key" | "stage" | "version">): ResolvedRecipe[] {
  return recipeSeedRows
    .filter((row) => row.active && row.key === recipe.key && row.stage === recipe.stage && row.version !== recipe.version)
    .sort((a, b) => b.version - a.version)
    .map(fromSeed);
}

/** The recipe a job runs for a stage: its assignment, else the seed. */
export function recipeFor(recipes: JobRecipes | undefined, stage: RecipeStage): ResolvedRecipe {
  return recipes?.[stage] ?? seedRecipe(stage);
}

/** The seed stages in order, each with the key the router and providers know. */
function seedStages(): Array<{ stage: RecipeStage; key: string }> {
  const out: Array<{ stage: RecipeStage; key: string }> = [];
  for (const stage of RecipeRow.shape.stage.options) {
    const row = servingRecipeSeedRow(stage);
    if (row) {
      out.push({ stage, key: row.key });
    }
  }
  return out;
}

/** Every stage on its compiled seed recipe. */
export function seedJobRecipes(): JobRecipes {
  const out: JobRecipes = {};
  for (const { stage } of seedStages()) {
    out[stage] = seedRecipe(stage);
  }
  return out;
}

/** Maps one recipes table row to a runnable recipe, or null when it cannot
 * run: an unknown stage, an empty prompt or no model. */
export function recipeFromRow(row: {
  id: string;
  key: string;
  version: number;
  stage: string;
  model: string;
  fallbackModels: unknown;
  body: Record<string, unknown>;
  trafficPct: number;
}): ResolvedRecipe | null {
  const fallbacks = Array.isArray(row.fallbackModels)
    ? row.fallbackModels.filter((m): m is string => typeof m === "string")
    : [];
  const parsed = RecipeRow.safeParse({
    key: row.key,
    version: row.version,
    stage: row.stage,
    model: row.model,
    fallbackModels: fallbacks,
    trafficPct: Math.max(0, Math.min(100, Math.trunc(row.trafficPct))),
    body: row.body,
    active: true,
  });
  if (!parsed.success) {
    return null;
  }
  return { ...fromSeed(parsed.data), recipeId: row.id, source: "db" };
}

/**
 * Deterministic weighted pick: the same job and key always land on the same
 * variant while the variant set is unchanged. Variants with weight 0 never
 * run; null when no variant has weight.
 */
export function pickVariant(variants: readonly ResolvedRecipe[], jobId: string): ResolvedRecipe | null {
  const live = variants.filter((v) => v.trafficPct > 0).sort((a, b) => a.version - b.version);
  const total = live.reduce((sum, v) => sum + v.trafficPct, 0);
  if (live.length === 0 || total <= 0) {
    return null;
  }
  const digest = createHash("sha256").update(`${jobId}:${live[0].key}`).digest();
  const bucket = (digest.readUInt32BE(0) / 0x1_0000_0000) * total;
  let upTo = 0;
  for (const variant of live) {
    upTo += variant.trafficPct;
    if (bucket < upTo) {
      return variant;
    }
  }
  return live[live.length - 1];
}

/** What gets recorded on generation_jobs.recipe_variants. */
export function recipeVariantsOf(recipes: JobRecipes): Record<string, JobRecipeVariant> {
  const out: Record<string, JobRecipeVariant> = {};
  for (const recipe of Object.values(recipes)) {
    if (recipe) {
      out[recipe.key] = { recipeId: recipe.recipeId, version: recipe.version, source: recipe.source };
    }
  }
  return out;
}

/**
 * The recipes a job recorded (recipeVariantsOf), resolved again: a db
 * variant by its recipes row id among the active rows, a seed variant by its
 * compiled key and version. A stage whose recorded version no longer runs
 * (deactivated, or a seed version since replaced) takes `assigned`, the
 * job's assignment from the current rows. Pure, so it is unit tested.
 */
export function recipesFromVariants(
  variants: Readonly<Record<string, JobRecipeVariant>>,
  rows: readonly ResolvedRecipe[],
  assigned: JobRecipes,
): JobRecipes {
  const out: JobRecipes = {};
  for (const { stage, key } of seedStages()) {
    const recorded = variants[key];
    let recipe: ResolvedRecipe | null = null;
    if (recorded?.source === "db" && recorded.recipeId) {
      recipe = rows.find((r) => r.recipeId === recorded.recipeId && r.stage === stage && r.key === key) ?? null;
    } else if (recorded?.source === "seed") {
      const row = recipeSeedRows.find((r) => r.stage === stage && r.key === key && r.version === recorded.version);
      recipe = row ? fromSeed(row) : null;
    }
    const chosen = recipe ?? assigned[stage];
    if (chosen) {
      out[stage] = chosen;
    }
  }
  return out;
}

/** Loads the active recipes; throws when the source is unreachable. */
export type RecipeLoader = () => Promise<ResolvedRecipe[]>;

/** Reads every active row of the recipes table over the worker connection
 * (recipes is a platform table; the owner connection reads it). Rows that
 * cannot run are dropped with a warning. */
export function dbRecipeLoader(db: Db): RecipeLoader {
  return async () => {
    const rows = await db.select().from(recipes).where(eq(recipes.active, true));
    const resolved: ResolvedRecipe[] = [];
    for (const row of rows) {
      const recipe = recipeFromRow(row);
      if (recipe) {
        resolved.push(recipe);
      } else {
        console.warn(`[recipes] skipped recipe ${row.key} v${row.version}: it does not parse as a runnable recipe`);
      }
    }
    return resolved;
  };
}

export interface RecipeCatalogOptions {
  /** How long one read of the table serves. Default 60 seconds. */
  ttlMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}

export const RECIPE_CACHE_TTL_MS = 60_000;

/**
 * Caches the active recipes and assigns jobs their variants. A failed read
 * keeps serving the last good rows; with none, every stage runs on the seed.
 * A stage whose key has no usable row also runs on the seed. Only rows whose
 * key is the seed key for their stage count: that key is the task name the
 * router and the providers know.
 */
export class RecipeCatalog implements RecipeResolver {
  private rows: ResolvedRecipe[] | null = null;
  private loadedAt = 0;
  private inflight: Promise<ResolvedRecipe[] | null> | null = null;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly onError: (err: unknown) => void;

  constructor(
    private readonly load: RecipeLoader,
    opts: RecipeCatalogOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? RECIPE_CACHE_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.onError = opts.onError ?? ((err) => console.error("[recipes] could not read the recipes table; using cached or seed recipes", err));
  }

  private async current(): Promise<ResolvedRecipe[] | null> {
    if (this.rows && this.now() - this.loadedAt < this.ttlMs) {
      return this.rows;
    }
    this.inflight ??= this.load()
      .then((rows) => {
        this.rows = rows;
        this.loadedAt = this.now();
        return rows;
      })
      .catch((err: unknown) => {
        this.onError(err);
        return this.rows;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  async forJob(jobId: string): Promise<JobRecipes> {
    return this.assign(jobId, (await this.current()) ?? []);
  }

  async forVariants(jobId: string, variants: Record<string, JobRecipeVariant>): Promise<JobRecipes> {
    const rows = (await this.current()) ?? [];
    return recipesFromVariants(variants, rows, this.assign(jobId, rows));
  }

  private assign(jobId: string, rows: readonly ResolvedRecipe[]): JobRecipes {
    const out: JobRecipes = {};
    for (const { stage, key } of seedStages()) {
      const variants = rows.filter((r) => r.stage === stage && r.key === key);
      out[stage] = pickVariant(variants, jobId) ?? seedRecipe(stage);
    }
    return out;
  }
}
