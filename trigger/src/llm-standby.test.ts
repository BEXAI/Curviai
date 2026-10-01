/**
 * Wiring with only one LLM key set (docs/phases/PHASE_17.md, Tests): a job
 * assigned a serving version whose models have no key set runs on the active
 * standby version whose models do, with that version's own body (output
 * budget, effort per model, image detail), never the body written for the
 * other provider's models.
 */

import { describe, expect, it } from "vitest";
import { InMemoryBreakerStore, InMemoryCostMeter, ProviderRegistry, type LlmContentBlock } from "@curvi/ai";
import { TargetPick, TargetPickAnswer } from "@curvi/pipeline";
import { recipeSeedRows } from "@curvi/pipeline/seed";
import { wireLiveProviders } from "./live-runtime";
import { llmJson, runnableRecipe, type AiDeps } from "./pipeline-runner";
import { seedRecipe, standbySeedRecipes } from "./recipes";
import { demoRoutingTable } from "./runtime";

type Body = Record<string, unknown>;

function wired(keys: string[]) {
  const registry = new ProviderRegistry();
  const routing = demoRoutingTable();
  const bodies: Array<{ url: string; body: Body }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    bodies.push({ url, body: JSON.parse(String(init?.body)) as Body });
    const answer = JSON.stringify({ choice: 1, confidence: "high", reason: "one mug" });
    const reply = url.endsWith("/v1/responses")
      ? {
          id: "resp_1",
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: answer, annotations: [] }] }],
          usage: { input_tokens: 100, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 } },
        }
      : {
          content: [{ type: "tool_use", name: "emit_result", input: JSON.parse(answer) as unknown }],
          stop_reason: "tool_use",
          usage: { input_tokens: 100, output_tokens: 20 },
        };
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  wireLiveProviders(registry, routing, (name) => (keys.includes(name) ? "key" : undefined), fetchFn);
  const ai: AiDeps = { registry, routing, meter: new InMemoryCostMeter(), breakerStore: new InMemoryBreakerStore() };
  return { ai, bodies };
}

const image: LlmContentBlock = { type: "image", mediaType: "image/png", base64: "AAAA" };
const ctx = { jobId: "job-standby", workspaceId: "ws-standby", stepId: "pick" };

describe("only one LLM key set", () => {
  it("runs a job on the Claude rollback version of target_picker on the OpenAI version's body when only OPENAI_API_KEY is set", async () => {
    const { ai, bodies } = wired(["OPENAI_API_KEY"]);
    // The OpenAI version serves (2026-10-01); a job assigned the Claude
    // rollback version (a rollback, or a recorded variant) has no live model.
    const assigned = standbySeedRecipes(seedRecipe("pick")).find((recipe) =>
      recipe.models.every((model) => model.startsWith("claude-")),
    );
    expect(assigned, "an active Claude target_picker version").toBeDefined();
    if (!assigned) return;
    const standby = recipeSeedRows.find(
      (row) => row.key === assigned.key && row.active && row.version !== assigned.version && row.model.startsWith("gpt-"),
    );
    expect(standby, "an active OpenAI target_picker version").toBeDefined();
    if (!standby) return;
    const effort = standby.body.modelOptions?.[standby.model]?.effort;
    expect(effort).toBeDefined();
    expect(standby.body.system).not.toBe(assigned.system);

    const call = await llmJson(ai, assigned, TargetPickAnswer, { n: 1 }, ctx, [image], TargetPick);

    expect(call.value).toEqual({ choice: 1, confidence: "high", reason: "one mug" });
    expect(bodies).toHaveLength(1);
    const { url, body } = bodies[0];
    expect(url).toMatch(/\/v1\/responses$/);
    expect(body.model).toBe(standby.model);
    expect(body.max_output_tokens).toBe(standby.body.maxTokens);
    expect(body.reasoning).toEqual({ effort });
    expect(body.instructions).toBe(standby.body.system);
    const content = (body.input as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
    expect(content.find((part) => part.type === "input_image")?.detail).toBe(standby.body.imageDetail ?? "high");
  });

  it("keeps the job's own recipe when one of its models is live", () => {
    const { ai } = wired(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    const serving = seedRecipe("pick");
    expect(runnableRecipe(ai, serving)).toBe(serving);
  });

  it("runs the serving version on its Claude fallback, Sonnet 5, when only ANTHROPIC_API_KEY is set", async () => {
    const { ai, bodies } = wired(["ANTHROPIC_API_KEY"]);
    const serving = seedRecipe("pick");
    expect(runnableRecipe(ai, serving)).toBe(serving);
    await llmJson(ai, serving, TargetPickAnswer, { n: 1 }, ctx, [image], TargetPick);
    expect(bodies[0].url).toMatch(/\/v1\/messages$/);
    expect(bodies[0].body.model).toBe("claude-sonnet-5");
    expect(bodies[0].body.max_tokens).toBe(serving.maxTokens);
    expect(bodies[0].body.output_config).toEqual({ effort: "low" });
  });

  it("leaves the recipe alone in demo mode, where no version is live", () => {
    const { ai } = wired([]);
    const serving = seedRecipe("pick");
    expect(runnableRecipe(ai, serving)).toBe(serving);
  });

  it("finds a live standby for every serving recipe when only OPENAI_API_KEY is set", () => {
    const { ai } = wired(["OPENAI_API_KEY"]);
    for (const stage of ["intake", "analyze", "plan", "copy", "qc", "pick", "brand", "question"] as const) {
      const serving = seedRecipe(stage);
      const run = runnableRecipe(ai, serving);
      expect(run.models.some((model) => model.startsWith("gpt-")), stage).toBe(true);
      if (run !== serving) {
        expect(standbySeedRecipes(serving).map((r) => r.version)).toContain(run.version);
        expect(run.key).toBe(serving.key);
      }
    }
  });
});
