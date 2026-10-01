import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { InMemoryBreakerStore, InMemoryCostMeter, ProviderError, ProviderRegistry, type LlmRequest } from "@curvi/ai";
import { MockProvider } from "@curvi/ai/testing";
import { loadRecipes, type Db } from "@curvi/db";
import { createTestDb, type TestDb } from "@curvi/db/testing";
import { llmModelPrices, llmModelProviders, recipeSeedRows } from "@curvi/pipeline/seed";
import {
  activeRecipe,
  assignRecipes,
  InMemoryJobStore,
  runGeneratePack,
  systemClock,
  type AiDeps,
  type GeneratePackInput,
} from "./pipeline-runner";
import {
  dbRecipeLoader,
  llmModelProviderName,
  openaiLlmPriceTable,
  pickVariant,
  RecipeCatalog,
  recipeFor,
  recipeFromRow,
  recipesFromVariants,
  recipeVariantsOf,
  seedJobRecipes,
  seedRecipe,
  type JobRecipes,
  type ResolvedRecipe,
} from "./recipes";
import { demoProfile, DemoShotGenerator } from "./runtime";

const planKey = activeRecipe("plan").key;

function variant(version: number, trafficPct: number, overrides: Partial<ResolvedRecipe> = {}): ResolvedRecipe {
  return {
    ...seedRecipe("plan"),
    recipeId: `recipe-${version}`,
    source: "db",
    version,
    trafficPct,
    system: `planner prompt v${version}`,
    ...overrides,
  };
}

describe("pickVariant", () => {
  it("assigns the same job the same variant every time", () => {
    const variants = [variant(1, 50), variant(2, 50)];
    for (const jobId of ["a", "b", "c", "job-42"]) {
      const first = pickVariant(variants, jobId);
      expect(pickVariant([...variants].reverse(), jobId)).toBe(first);
    }
  });

  it("splits traffic by weight across many jobs", () => {
    const variants = [variant(1, 80), variant(2, 20)];
    let second = 0;
    const jobs = 4000;
    for (let i = 0; i < jobs; i++) {
      if (pickVariant(variants, `job-${i}`)?.version === 2) second += 1;
    }
    expect(second / jobs).toBeGreaterThan(0.17);
    expect(second / jobs).toBeLessThan(0.23);
  });

  it("never picks a weight 0 variant and returns null when nothing has weight", () => {
    const variants = [variant(1, 0), variant(2, 100)];
    for (let i = 0; i < 50; i++) {
      expect(pickVariant(variants, `job-${i}`)?.version).toBe(2);
    }
    expect(pickVariant([variant(1, 0)], "job")).toBeNull();
    expect(pickVariant([], "job")).toBeNull();
  });
});

describe("recipeFromRow", () => {
  const row = {
    id: "r1",
    key: planKey,
    version: 3,
    stage: "plan",
    model: "model-a",
    fallbackModels: ["model-b", "model-a", 7],
    body: { system: "plan the pack" },
    trafficPct: 40,
  };

  it("maps a row to its failover order, primary first, without duplicates or non strings", () => {
    const recipe = recipeFromRow(row);
    expect(recipe).toMatchObject({ recipeId: "r1", source: "db", version: 3, trafficPct: 40, system: "plan the pack" });
    expect(recipe?.models).toEqual(["model-a", "model-b"]);
  });

  it("carries the body's effort per model and its timeout", () => {
    const modelOptions = { "model-a": { effort: "low" as const }, "model-b": { effort: "none" as const } };
    const recipe = recipeFromRow({ ...row, body: { system: "plan the pack", modelOptions, timeoutMs: 90_000 } });
    expect(recipe?.modelOptions).toEqual(modelOptions);
    expect(recipe?.timeoutMs).toBe(90_000);
    expect(recipeFromRow(row)).not.toHaveProperty("modelOptions");
    expect(recipeFromRow(row)).not.toHaveProperty("timeoutMs");
  });

  it("drops rows that cannot run", () => {
    expect(recipeFromRow({ ...row, body: { system: "x".repeat(10), modelOptions: { "model-a": { effort: "huge" } } } })).toBeNull();
    // The provider specific thinking field is gone from the neutral options.
    expect(
      recipeFromRow({ ...row, body: { system: "x".repeat(10), modelOptions: { "model-a": { thinking: "disabled" } } } }),
    ).toBeNull();
    expect(recipeFromRow({ ...row, body: { system: "x".repeat(10), timeoutMs: 5 } })).toBeNull();
    expect(recipeFromRow({ ...row, body: { system: "" } })).toBeNull();
    expect(recipeFromRow({ ...row, stage: "render" })).toBeNull();
    expect(recipeFromRow({ ...row, model: "" })).toBeNull();
  });
});

describe("openaiLlmPriceTable", () => {
  it("carries the seeded cache write price to the OpenAI adapter", () => {
    expect(openaiLlmPriceTable(llmModelPrices["gpt-6.1-sol"]!)).toEqual({
      inputMicrosPerMTok: 2_000_000,
      cachedInputMicrosPerMTok: 100_000,
      cacheWriteMicrosPerMTok: 2_500_000,
      outputMicrosPerMTok: 10_000_000,
    });
    expect(
      openaiLlmPriceTable({ inputMicrosPerMTok: 1, cachedInputMicrosPerMTok: 1, outputMicrosPerMTok: 1 }),
    ).not.toHaveProperty("cacheWriteMicrosPerMTok");
    expect(openaiLlmPriceTable(llmModelPrices["claude-sonnet-5"]!)).toBeUndefined();
  });

  it("seeds a cache write price on every OpenAI model", () => {
    for (const [model, provider] of Object.entries(llmModelProviders)) {
      if (provider !== "openai") continue;
      expect(llmModelPrices[model]?.cacheWriteMicrosPerMTok, model).toBeGreaterThan(0);
    }
  });
});

describe("llmModelProviderName", () => {
  it("names each model by its seeded provider", () => {
    for (const [model, provider] of Object.entries(llmModelProviders)) {
      expect(llmModelProviderName(model)).toBe(`${provider}:${model}`);
    }
    expect(llmModelProviderName("claude-sonnet-5")).toBe("anthropic:claude-sonnet-5");
  });

  it("maps every priced model and every seeded recipe model to a provider", () => {
    for (const model of Object.keys(llmModelPrices)) {
      expect(llmModelProviders[model], model).toBeDefined();
    }
    for (const row of recipeSeedRows) {
      for (const model of [row.model, ...(row.fallbackModels ?? [])]) {
        expect(llmModelProviders[model], `${row.key} v${row.version} ${model}`).toBeDefined();
      }
    }
  });

  it("fails closed for a model with no provider: no live provider is ever registered under its name", () => {
    const name = llmModelProviderName("unknown-model");
    for (const provider of new Set(Object.values(llmModelProviders))) {
      expect(name.startsWith(`${provider}:`)).toBe(false);
    }
    expect(llmModelProviderName("toString")).not.toMatch(/^(anthropic|openai):/);
  });
});

describe("RecipeCatalog", () => {
  it("runs a table variant for its stage and the seed for stages without one", async () => {
    const catalog = new RecipeCatalog(async () => [variant(2, 100)]);
    const recipes = await catalog.forJob("job-1");
    expect(recipes.plan?.version).toBe(2);
    expect(recipes.plan?.source).toBe("db");
    expect(recipes.intake).toEqual(seedRecipe("intake"));
  });

  it("ignores rows whose key is not the stage's seed key", async () => {
    const catalog = new RecipeCatalog(async () => [variant(2, 100, { key: "some_other_planner" })]);
    expect((await catalog.forJob("job-1")).plan).toEqual(seedRecipe("plan"));
  });

  it("reads the table once per cache window", async () => {
    let clock = 0;
    let loads = 0;
    const catalog = new RecipeCatalog(
      async () => {
        loads += 1;
        return [variant(loads, 100)];
      },
      { ttlMs: 1000, now: () => clock },
    );
    await Promise.all([catalog.forJob("a"), catalog.forJob("b")]);
    await catalog.forJob("c");
    expect(loads).toBe(1);
    clock = 1500;
    expect((await catalog.forJob("d")).plan?.version).toBe(2);
    expect(loads).toBe(2);
  });

  it("keeps serving the last good rows when a read fails, and the seed when it never read", async () => {
    let clock = 0;
    let fail = false;
    const errors: unknown[] = [];
    const catalog = new RecipeCatalog(
      async () => {
        if (fail) throw new Error("database down");
        return [variant(5, 100)];
      },
      { ttlMs: 10, now: () => clock, onError: (err) => errors.push(err) },
    );
    expect((await catalog.forJob("a")).plan?.version).toBe(5);
    fail = true;
    clock = 100;
    expect((await catalog.forJob("a")).plan?.version).toBe(5);
    expect(errors).toHaveLength(1);

    const cold = new RecipeCatalog(
      async () => {
        throw new Error("database down");
      },
      { onError: () => undefined },
    );
    expect(await cold.forJob("a")).toEqual(seedJobRecipes());
  });
});

describe("recorded recipe variants (pack follow ups)", () => {
  it("resolves the versions a job recorded, not a fresh pick", async () => {
    // Two live variants; the job recorded version 2 whatever its hash picks now.
    const catalog = new RecipeCatalog(async () => [variant(1, 99), variant(2, 1)]);
    const recorded = recipeVariantsOf({ plan: variant(2, 1) });
    for (const jobId of ["a", "b", "c", "job-42"]) {
      const recipes = await catalog.forVariants(jobId, recorded);
      expect(recipes.plan?.version).toBe(2);
      expect(recipes.qc).toEqual(seedRecipe("qc"));
    }
  });

  it("falls back to the job's assignment when the recorded version no longer runs", async () => {
    const catalog = new RecipeCatalog(async () => [variant(3, 100)]);
    const recorded = { [planKey]: { recipeId: "recipe-2", version: 2, source: "db" as const } };
    expect((await catalog.forVariants("job-1", recorded)).plan?.version).toBe(3);
    // A recorded seed version resolves to the compiled seed.
    const seeded = recipeVariantsOf(seedJobRecipes());
    expect(recipesFromVariants(seeded, [variant(3, 100)], {})).toEqual(seedJobRecipes());
  });
});

describe("dbRecipeLoader", () => {
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

  it("reads active rows, so a seeded table plus a new version is an A/B test", async () => {
    await loadRecipes(db as unknown as Db, recipeSeedRows);
    // The serving planner; its rollback predecessor stays at weight 0.
    const planner = recipeSeedRows.find((r) => r.stage === "plan" && r.version === seedRecipe("plan").version)!;
    const next = planner.version + 10;
    await loadRecipes(db as unknown as Db, [
      { ...planner, version: next, fallbackModels: [], body: { system: "planner next" }, trafficPct: 50 },
      { ...planner, version: next + 1, body: { system: "retired planner" }, active: false },
    ]);
    await client.query("update recipes set traffic_pct = 50 where key = $1 and version = $2", [
      planner.key,
      planner.version,
    ]);

    const catalog = new RecipeCatalog(dbRecipeLoader(db as unknown as Db));
    const versions = new Set<number>();
    for (let i = 0; i < 60; i++) {
      const recipes = await catalog.forJob(`job-${i}`);
      versions.add(recipes.plan!.version);
      expect(recipes.plan!.source).toBe("db");
      expect(recipes.intake!.source).toBe("db");
    }
    expect([...versions].sort((a, b) => a - b)).toEqual([planner.version, next]);
    const recipes = await catalog.forJob("job-1");
    expect(recipes.intake!.models).toEqual(seedRecipe("intake").models);
    expect(recipes.intake!.version).toBe(seedRecipe("intake").version);
  });
});

const intakeFixture = {
  images: [
    {
      sellableProduct: true,
      distinctProducts: 1,
      sharpEnough: true,
      flags: { nudity: false, weapons: false, drugs: false, prohibited: false, realPersonMainSubject: false },
    },
  ],
};

const baseInput: GeneratePackInput = {
  jobId: "job-recipes",
  workspaceId: "ws1",
  tier: "starter",
  channels: ["amazon"],
  creditBudget: 20,
  images: [{ mediaId: "m1" }],
};

function makeAi(extra: MockProvider[] = []): { ai: AiDeps; qc: MockProvider; intake: MockProvider } {
  const keys = {
    intake: activeRecipe("intake").key,
    analyze: activeRecipe("analyze").key,
    plan: planKey,
    qc: activeRecipe("qc").key,
  };
  const intake = new MockProvider({ name: "mock-intake", tasks: [keys.intake], output: intakeFixture });
  const analyze = new MockProvider({ name: "mock-analyze", tasks: [keys.analyze], output: demoProfile });
  const plan = new MockProvider({ name: "mock-plan", tasks: [keys.plan], output: { notAShotList: true } });
  const qc = new MockProvider({
    name: "mock-qc",
    tasks: [keys.qc],
    output: { pass: true, fidelity: 0.97, issues: [], repairHint: "" },
  });
  const registry = new ProviderRegistry();
  for (const provider of [intake, analyze, plan, qc, ...extra]) registry.register(provider);
  return {
    ai: {
      registry,
      routing: {
        [keys.intake]: [intake.name],
        [keys.analyze]: [analyze.name],
        [keys.plan]: [plan.name],
        [keys.qc]: [qc.name],
      },
      meter: new InMemoryCostMeter(),
      breakerStore: new InMemoryBreakerStore(),
    },
    qc,
    intake,
  };
}

describe("runGeneratePack with runtime recipes", () => {
  it("fails over along the recipe's models, uses the variant prompts and records the assignment", async () => {
    const intakeKey = activeRecipe("intake").key;
    const primary = new MockProvider({
      name: llmModelProviderName("model-primary"),
      tasks: [intakeKey],
      failTimes: Infinity,
      failWith: () => new ProviderError("model is down", llmModelProviderName("model-primary"), intakeKey, false),
    });
    const backup = new MockProvider({ name: llmModelProviderName("model-backup"), tasks: [intakeKey], output: intakeFixture });
    const { ai, qc, intake } = makeAi([primary, backup]);
    const recipes: JobRecipes = {
      ...seedJobRecipes(),
      intake: {
        ...seedRecipe("intake"),
        recipeId: "intake-v4",
        source: "db",
        version: 4,
        models: ["model-primary", "model-unpriced", "model-backup"],
        system: "intake variant prompt",
      },
      qc: { ...seedRecipe("qc"), recipeId: "qc-v2", source: "db", version: 2, system: "qc variant prompt" },
    };
    const store = new InMemoryJobStore();
    const summary = await runGeneratePack(baseInput, {
      ai,
      store,
      clock: systemClock,
      generator: new DemoShotGenerator(),
      recipes: { forJob: async () => recipes },
    });

    expect(summary.state).toBe("done");
    expect(primary.invocations).toBe(1);
    expect(backup.invocations).toBe(1);
    // The routing table entry is bypassed while a recipe model is live.
    expect(intake.invocations).toBe(0);
    const sent = backup.calls[0].input as LlmRequest & { model?: string };
    expect(sent.system).toBe("intake variant prompt");
    expect(sent.model).toBeUndefined();
    // No recipe model is registered for QC, so the routing table serves it
    // with the variant's prompt.
    expect(qc.invocations).toBeGreaterThan(0);
    expect((qc.calls[0].input as LlmRequest).system).toBe("qc variant prompt");
    expect(store.recipeVariants.get(baseInput.jobId)).toMatchObject({
      [intakeKey]: { recipeId: "intake-v4", version: 4, source: "db" },
      [activeRecipe("qc").key]: { recipeId: "qc-v2", version: 2, source: "db" },
      [planKey]: { recipeId: null, version: seedRecipe("plan").version, source: "seed" },
    });
  });

  it("sends the analyzer recipe's per model options and timeout with the call", async () => {
    const { ai } = makeAi();
    const analyze = ai.registry.get("mock-analyze") as MockProvider;
    const store = new InMemoryJobStore();
    await runGeneratePack(
      { ...baseInput, jobId: "job-recipe-options" },
      { ai, store, clock: systemClock, generator: new DemoShotGenerator(), recipes: { forJob: async () => seedJobRecipes() } },
    );
    const seeded = seedRecipe("analyze");
    expect(seeded.modelOptions).toBeDefined();
    expect(analyze.calls.length).toBeGreaterThan(0);
    const req = analyze.calls[0];
    expect((req.input as LlmRequest).modelOptions).toEqual(seeded.modelOptions);
    expect((req.input as LlmRequest).maxOutputTokens).toBe(seeded.maxTokens);
    expect(req.timeoutMs).toBe(seeded.timeoutMs);
  });

  it("runs on the seed when the resolver throws or the store cannot record", async () => {
    const store = new InMemoryJobStore();
    store.saveRecipeVariants = async () => {
      throw new Error("write failed");
    };
    const recipes = await assignRecipes("job", {
      store,
      recipes: {
        forJob: async () => {
          throw new Error("boom");
        },
      },
    });
    expect(recipes).toEqual(seedJobRecipes());
    expect(recipeFor(undefined, "qc")).toEqual(seedRecipe("qc"));
    expect(recipeVariantsOf(recipes)[planKey]).toEqual({ recipeId: null, version: seedRecipe("plan").version, source: "seed" });
  });
});
