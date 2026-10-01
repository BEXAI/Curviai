/**
 * Phase 17: every OpenAI recipe version ends its chain on a Claude model
 * (founder decision 1). When the OpenAI account runs out of credit, every
 * call fails over to Claude, so the request Claude receives must still steer
 * it to the strict emit_result tool rather than a plain text answer. This
 * runs llmJson on each OpenAI version through the real OpenAI adapters (a
 * mocked insufficient_quota answer) and the real Anthropic adapter (a
 * recording fetch). No network call is made.
 */

import { describe, expect, it } from "vitest";
import {
  AnthropicLLMProvider,
  InMemoryBreakerStore,
  InMemoryCostMeter,
  OpenaiLLMProvider,
  ProviderRegistry,
} from "@curvi/ai";
import { IntakeToolResult } from "@curvi/pipeline";
import { llmImageTokenMultipliers, llmModelPrices, llmModelProviders, recipeSeedRows } from "@curvi/pipeline/seed";
import { z } from "zod";
import { llmJson, type AiDeps } from "./pipeline-runner";
import { llmModelProviderName, openaiLlmPriceTable, recipeFromRow } from "./recipes";

const quotaFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" },
    }),
    { status: 429, headers: { "content-type": "application/json" } },
  );

const TOOL_SENTENCE = "When a tool is offered for the result, return the object by calling that tool, never as plain text.";

const openaiRows = recipeSeedRows.filter((row) => llmModelProviders[row.model] === "openai");

describe("Claude fallback after an OpenAI quota answer (phase 17)", () => {
  it("covers every OpenAI recipe version", () => {
    expect(openaiRows.map((row) => `${row.key} v${row.version}`).sort()).toEqual(
      [
        "brand_palette_namer v2",
        "copy_generator v4",
        "intake_normalizer v7",
        "product_analyzer v4",
        "qc_judge v2",
        "question_planner v2",
        "shot_planner v3",
        "target_picker v2",
      ].sort(),
    );
  });

  it.each(openaiRows.map((row) => [`${row.key} v${row.version}`, row] as const))(
    "%s fails over to Claude with the emit_result tool and a prompt that asks for it",
    async (_label, row) => {
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
      expect(recipe).not.toBeNull();
      if (!recipe) return;
      const claude = recipe.models.at(-1) ?? "";
      expect(llmModelProviders[claude]).toBe("anthropic");

      const registry = new ProviderRegistry();
      const openaiCalls: string[] = [];
      for (const model of recipe.models.slice(0, -1)) {
        expect(llmModelProviders[model]).toBe("openai");
        const priceTable = openaiLlmPriceTable(llmModelPrices[model]);
        const imageTokenMultiplier = llmImageTokenMultipliers[model];
        expect(priceTable).toBeDefined();
        expect(imageTokenMultiplier).toBeGreaterThan(0);
        if (!priceTable || imageTokenMultiplier === undefined) return;
        registry.register(
          new OpenaiLLMProvider({
            name: llmModelProviderName(model),
            tasks: [recipe.key],
            apiKey: "test-key",
            model,
            priceTable,
            imageTokenMultiplier,
            fetchFn: async (url, init) => {
              openaiCalls.push(model);
              return quotaFetch(url, init);
            },
          }),
        );
      }

      const claudeBodies: Array<Record<string, unknown>> = [];
      const answer = { ok: true };
      registry.register(
        new AnthropicLLMProvider({
          name: llmModelProviderName(claude),
          tasks: [recipe.key],
          apiKey: "test-key",
          model: claude,
          priceTable: llmModelPrices[claude],
          fetchFn: async (_url, init) => {
            claudeBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
            return new Response(
              JSON.stringify({
                content: [{ type: "tool_use", name: "emit_result", input: answer }],
                stop_reason: "tool_use",
                usage: { input_tokens: 10, output_tokens: 5 },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        }),
      );

      const ai: AiDeps = {
        registry,
        routing: { [recipe.key]: recipe.models.map(llmModelProviderName) },
        meter: new InMemoryCostMeter(),
        breakerStore: new InMemoryBreakerStore(),
      };
      const outputSchema = recipe.stage === "intake" ? IntakeToolResult : z.object({ ok: z.boolean() });
      const result = await llmJson(
        ai,
        recipe,
        { safeParse: (data: unknown) => ({ success: true, data }) },
        { userDescription: "<user_description>red mug</user_description>" },
        { jobId: "job-fallback", workspaceId: "ws-fallback", stepId: recipe.stage },
        undefined,
        outputSchema,
      );

      // Each OpenAI model answered quota once and was not retried.
      expect(openaiCalls).toEqual(recipe.models.slice(0, -1));
      expect(claudeBodies).toHaveLength(1);
      const body = claudeBodies[0];
      expect(body.model).toBe(claude);
      expect(body.tool_choice).toEqual({ type: "auto" });
      expect((body.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["emit_result"]);
      // The JSON line ends the prompt and tells Claude to call the tool, so
      // it never pulls Claude off the strict schema into a text answer.
      expect(String(body.system).endsWith(TOOL_SENTENCE)).toBe(true);
      expect(result.value).toEqual(answer);
    },
  );
});
