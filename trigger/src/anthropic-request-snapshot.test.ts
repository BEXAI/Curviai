/**
 * Phase 17 workstream 1: the provider neutral LLM contract must not change a
 * single byte of what Anthropic receives. For every seeded recipe (active or
 * not), every model in its failover chain, and both the strict request and
 * the non strict retry after a 400, this builds the request exactly as the
 * runner does (llmJson, with vision blocks from visionBlocks for the vision
 * stages), runs it through AnthropicLLMProvider with a recording fetch, and
 * compares a hash of the raw request body to the snapshot recorded before the
 * refactor. No network call is made.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AnthropicLLMProvider,
  InMemoryBreakerStore,
  InMemoryCostMeter,
  ProviderError,
  ProviderRegistry,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
} from "@curvi/ai";
import {
  AplusCopyResult,
  encodePng,
  IntakeToolResult,
  LlmShotList,
  PackCopyResult,
  PaletteNaming,
  ProductProfile,
  QCVerdict,
  QuestionPlanTool,
  solidCanvas,
  TargetPick,
} from "@curvi/pipeline";
import { llmModelPrices, llmModelProviders, recipeSeedRows } from "@curvi/pipeline/seed";
import type { z } from "zod";
import { llmJson, visionBlocks, type AiDeps } from "./pipeline-runner";
import { llmModelProviderName, recipeFromRow, type RecipeStage, type ResolvedRecipe } from "./recipes";

const workspaceId = "ws-snap";

function outputSchemaFor(recipe: ResolvedRecipe): z.ZodType {
  const byStage: Record<RecipeStage, z.ZodType> = {
    intake: IntakeToolResult,
    analyze: ProductProfile,
    plan: LlmShotList,
    copy: recipe.version >= 3 ? PackCopyResult : AplusCopyResult,
    qc: QCVerdict,
    pick: TargetPick,
    brand: PaletteNaming,
    question: QuestionPlanTool,
  };
  return byStage[recipe.stage];
}

const VISION_STAGES: ReadonlySet<RecipeStage> = new Set<RecipeStage>(["intake", "analyze", "qc", "pick", "brand"]);

/** The inputs llmJson hands the providers for one recipe: the strict
 * request, then the non strict retry the runner sends after a 400. */
async function capturedInputs(recipe: ResolvedRecipe): Promise<unknown[]> {
  const [png1, png2] = await Promise.all([
    encodePng(solidCanvas(24, 16, 200, 100, 50)),
    encodePng(solidCanvas(12, 20, 10, 120, 240)),
  ]);
  const media: Record<string, Buffer> = { [`ws/${workspaceId}/src/a.png`]: png1, [`ws/${workspaceId}/src/b.png`]: png2 };
  const blocks = VISION_STAGES.has(recipe.stage)
    ? await visionBlocks(
        { loadMedia: async (key: string) => media[key] ?? null },
        Object.keys(media).map((mediaId) => ({ mediaId })),
        workspaceId,
        2,
      )
    : undefined;
  const primary = llmModelProviderName(recipe.models[0]);
  // A copy of each input as sent: the runner may reuse one input object
  // across its strict and non strict attempts.
  const sent: unknown[] = [];
  const mock: Provider = {
    name: primary,
    kind: "llm",
    supports: (task) => task === recipe.key,
    invoke: async <TIn, TOut>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> => {
      sent.push(structuredClone(req.input));
      if (sent.length === 1) {
        throw new ProviderError(`${primary} responded 400: schema rejected`, primary, recipe.key, false);
      }
      return { output: {} as TOut, costMicros: 0 };
    },
  };
  const registry = new ProviderRegistry();
  registry.register(mock);
  const ai: AiDeps = {
    registry,
    routing: { [recipe.key]: [primary] },
    meter: new InMemoryCostMeter(),
    breakerStore: new InMemoryBreakerStore(),
  };
  await llmJson(
    ai,
    recipe,
    { safeParse: (data: unknown) => ({ success: true, data }) },
    { userDescription: "<user_description>red mug</user_description>", n: 1 },
    { jobId: "job-snap", workspaceId, stepId: recipe.stage },
    blocks,
    outputSchemaFor(recipe),
  );
  return sent;
}

/** The raw body AnthropicLLMProvider posts for one input on one model. */
async function anthropicBody(recipe: ResolvedRecipe, model: string, input: unknown): Promise<string> {
  let body = "";
  const provider = new AnthropicLLMProvider({
    name: llmModelProviderName(model),
    tasks: [recipe.key],
    apiKey: "test-key",
    model,
    priceTable: llmModelPrices[model],
    fetchFn: async (_url, init) => {
      body = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          content: [{ type: "tool_use", name: "emit_result", input: {} }],
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  await provider.invoke({ task: recipe.key, input });
  return body;
}

describe("Anthropic request bodies (phase 17 workstream 1)", () => {
  it("are byte for byte unchanged for every recipe, model and strict mode", async () => {
    const hashes: Record<string, string> = {};
    for (const row of recipeSeedRows) {
      // The proof covers the Claude versions that existed before Phase 17;
      // the OpenAI versions (workstream 3) are new requests, not changes.
      if (llmModelProviders[row.model] !== "anthropic") continue;
      const recipe = recipeFromRow({
        id: `${row.key}-v${row.version}`,
        key: row.key,
        version: row.version,
        stage: row.stage,
        model: row.model,
        fallbackModels: row.fallbackModels ?? [],
        body: row.body,
        trafficPct: row.trafficPct ?? 100,
      });
      expect(recipe, `${row.key} v${row.version}`).not.toBeNull();
      if (!recipe) continue;
      const inputs = await capturedInputs(recipe);
      expect(inputs).toHaveLength(2);
      for (const model of recipe.models) {
        for (const [i, mode] of ["strict", "plain"].entries()) {
          const body = await anthropicBody(recipe, model, inputs[i]);
          hashes[`${row.key} v${row.version} ${model} ${mode}`] = createHash("sha256").update(body).digest("hex");
        }
      }
    }
    expect(hashes).toMatchSnapshot();
  });
});
