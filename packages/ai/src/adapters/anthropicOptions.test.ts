/**
 * Recipe effort options, the neutral request translation and the max_tokens
 * stop on the Anthropic adapter (audit 2026-09-29, PHASE_17 workstream 1).
 * No network: fetch is stubbed.
 */
import { describe, expect, it } from "vitest";
import { ProviderError } from "../types";
import type { LlmRequest, LlmResult } from "../llm";
import { AnthropicLLMProvider } from "./anthropicLLM";

const prices = { inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000 };

function provider(model: string, reply: unknown, sent: Array<Record<string, unknown>>) {
  return new AnthropicLLMProvider({
    name: `anthropic:${model}`,
    tasks: ["product_analyzer"],
    apiKey: "test-key",
    model,
    priceTable: prices,
    fetchFn: (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
}

const toolReply = {
  content: [{ type: "tool_use", name: "emit_result", input: { ok: true } }],
  stop_reason: "tool_use",
  usage: { input_tokens: 100, output_tokens: 50 },
};

const input: LlmRequest = {
  system: "s",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  output: { name: "emit_result", schema: { type: "object" }, strict: true },
  maxOutputTokens: 8000,
  modelOptions: {
    "claude-sonnet-5": { effort: "medium" },
    "claude-opus-5-5": { effort: "low" },
  },
};

function textRequest(text: string): LlmRequest {
  return { system: "s", messages: [{ role: "user", content: [{ type: "text", text }] }] };
}

describe("Anthropic recipe model options", () => {
  it("sends output_config.effort for the model this provider runs, leaving adaptive thinking to the model", async () => {
    const sent: Array<Record<string, unknown>> = [];
    await provider("claude-sonnet-5", toolReply, sent).invoke({ task: "product_analyzer", input });
    expect(sent[0]).not.toHaveProperty("thinking");
    expect(sent[0].output_config).toEqual({ effort: "medium" });
    expect(sent[0].max_tokens).toBe(8000);
  });

  it("an effort of none turns thinking off and sends no effort", async () => {
    const sent: Array<Record<string, unknown>> = [];
    await provider("claude-sonnet-5", toolReply, sent).invoke({
      task: "product_analyzer",
      input: { ...input, modelOptions: { "claude-sonnet-5": { effort: "none" } } },
    });
    expect(sent[0].thinking).toEqual({ type: "disabled" });
    expect(sent[0]).not.toHaveProperty("output_config");
  });

  it("a request level effort applies to a model with no entry of its own", async () => {
    const sent: Array<Record<string, unknown>> = [];
    await provider("claude-sonnet-5", toolReply, sent).invoke({
      task: "product_analyzer",
      input: { ...input, effort: "high", modelOptions: {} },
    });
    expect(sent[0].output_config).toEqual({ effort: "high" });
  });

  it("sends only the fallback model's own entry", async () => {
    const sent: Array<Record<string, unknown>> = [];
    await provider("claude-opus-5-5", toolReply, sent).invoke({ task: "product_analyzer", input });
    expect(sent[0].thinking).toBeUndefined();
    expect(sent[0].output_config).toEqual({ effort: "low" });
  });

  it("sends neither field for a model with no entry", async () => {
    const sent: Array<Record<string, unknown>> = [];
    await provider("claude-haiku-4-5-20251001", toolReply, sent).invoke({ task: "product_analyzer", input });
    expect(sent[0]).not.toHaveProperty("thinking");
    expect(sent[0]).not.toHaveProperty("output_config");
  });
});

describe("Anthropic max_tokens stop", () => {
  it("a structured reply cut off at max_tokens is a billed, final output_truncated error", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const reply = {
      content: [{ type: "thinking", thinking: "" }, { type: "tool_use", name: "emit_result", input: { partial: 1 } }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 1_000, output_tokens: 8_000 },
    };
    const err = await provider("claude-sonnet-5", reply, sent)
      .invoke({ task: "product_analyzer", input })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ProviderError);
    const pe = err as ProviderError;
    expect(pe.code).toBe("output_truncated");
    expect(pe.retryable).toBe(false);
    expect(pe.transient).toBe(false);
    expect(pe.billedCostMicros).toBe(Math.ceil((1_000 * 2_000_000 + 8_000 * 10_000_000) / 1_000_000));
    expect(pe.message).toContain("max_tokens");
  });

  it("a reply with only a thinking block at max_tokens says it was cut off", async () => {
    const reply = {
      content: [{ type: "thinking", thinking: "" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 10, output_tokens: 4096 },
    };
    const err = (await provider("claude-sonnet-5", reply, [])
      .invoke({ task: "t", input: textRequest("x") })
      .catch((e: unknown) => e)) as ProviderError;
    expect(err.code).toBe("output_truncated");
  });

  it("a plain text reply at max_tokens with no output schema still returns, finished as truncated", async () => {
    const reply = {
      content: [{ type: "text", text: "partial" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 10, output_tokens: 20 },
    };
    const res = await provider("claude-sonnet-5", reply, []).invoke<LlmRequest, LlmResult>({
      task: "t",
      input: textRequest("x"),
    });
    expect(res.output.finish).toBe("truncated");
    expect(res.output.text).toBe("partial");
    expect(res.output.json).toBeNull();
  });
});

describe("Anthropic neutral request translation", () => {
  it("sends the output as the emit_result tool with tool_choice auto, strict only when asked", async () => {
    const sent: Array<Record<string, unknown>> = [];
    await provider("claude-sonnet-5", toolReply, sent).invoke({ task: "t", input });
    expect(sent[0].tools).toEqual([
      {
        name: "emit_result",
        description: expect.stringContaining("Always call this tool exactly once") as unknown,
        input_schema: { type: "object" },
        strict: true,
      },
    ]);
    expect(sent[0].tool_choice).toEqual({ type: "auto" });
    await provider("claude-sonnet-5", toolReply, sent).invoke({
      task: "t",
      input: { ...input, output: { name: "emit_result", schema: { type: "object" }, strict: false } },
    });
    expect((sent[1].tools as Array<Record<string, unknown>>)[0]).not.toHaveProperty("strict");
  });

  it("sends no tools for a request without an output", async () => {
    const sent: Array<Record<string, unknown>> = [];
    await provider("claude-sonnet-5", toolReply, sent).invoke({ task: "t", input: textRequest("x") });
    expect(sent[0]).not.toHaveProperty("tools");
    expect(sent[0]).not.toHaveProperty("tool_choice");
  });

  it("sends a text only message as a string and image blocks as base64 sources", async () => {
    const sent: Array<Record<string, unknown>> = [];
    await provider("claude-sonnet-5", toolReply, sent).invoke({ task: "t", input: textRequest("hello") });
    expect(sent[0].messages).toEqual([{ role: "user", content: "hello" }]);
    await provider("claude-sonnet-5", toolReply, sent).invoke({
      task: "t",
      input: {
        system: "s",
        messages: [
          {
            role: "user",
            content: [
              { type: "image", mediaType: "image/png", base64: "aGk=", detail: "high" },
              { type: "text", text: "what is this" },
            ],
          },
        ],
      },
    });
    expect(sent[1].messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
          { type: "text", text: "what is this" },
        ],
      },
    ]);
  });
});

describe("Anthropic neutral result", () => {
  const reply = (content: unknown[], stop = "end_turn") => ({
    content,
    stop_reason: stop,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 7 },
  });

  it("returns the tool input as json, finished complete, with usage", async () => {
    const res = await provider("claude-sonnet-5", toolReply, []).invoke<LlmRequest, LlmResult>({ task: "t", input });
    expect(res.output.json).toEqual({ ok: true });
    expect(res.output.finish).toBe("complete");
    expect(res.output.text).toBe("");
    expect(res.output.usage).toEqual({ inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, reasoningTokens: 0 });
    expect(res.costMicros).toBe(Math.ceil((100 * 2_000_000 + 50 * 10_000_000) / 1_000_000));
  });

  it("reports cache reads as cached input tokens", async () => {
    const res = await provider(
      "claude-sonnet-5",
      reply([{ type: "tool_use", name: "emit_result", input: {} }]),
      [],
    ).invoke<LlmRequest, LlmResult>({ task: "t", input });
    expect(res.output.usage.cachedInputTokens).toBe(7);
  });

  it("a text answer that holds JSON is the json, fenced or not", async () => {
    for (const text of ['{"a":1}', 'Here you go:\n```json\n{"a":1}\n```', 'Sure. {"a":1} Done.']) {
      const res = await provider("claude-sonnet-5", reply([{ type: "text", text }]), []).invoke<LlmRequest, LlmResult>({
        task: "t",
        input,
      });
      expect(res.output.json).toEqual({ a: 1 });
      expect(res.output.text).toBe(text);
    }
  });

  it("a missed tool call with no JSON in the text has json null, so the caller asks again", async () => {
    const res = await provider(
      "claude-sonnet-5",
      reply([{ type: "text", text: "I looked at it." }]),
      [],
    ).invoke<LlmRequest, LlmResult>({ task: "t", input });
    expect(res.output.json).toBeNull();
    expect(res.output.finish).toBe("complete");
  });
});
