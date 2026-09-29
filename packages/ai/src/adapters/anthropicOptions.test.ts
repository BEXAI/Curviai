/**
 * Recipe thinking and effort options and the max_tokens stop on the
 * Anthropic adapter (audit 2026-09-29). No network: fetch is stubbed.
 */
import { describe, expect, it } from "vitest";
import { ProviderError } from "../types";
import { AnthropicLLMProvider, type AnthropicLLMInput } from "./anthropicLLM";

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

const input: AnthropicLLMInput = {
  system: "s",
  messages: [{ role: "user", content: "hi" }],
  tools: [{ name: "emit_result", input_schema: { type: "object" } }],
  toolChoice: { type: "tool", name: "emit_result" },
  maxTokens: 8000,
  modelOptions: {
    "claude-sonnet-5": { thinking: "adaptive", effort: "medium" },
    "claude-opus-5-5": { effort: "low" },
  },
};

describe("Anthropic recipe model options", () => {
  it("sends thinking and output_config.effort for the model this provider runs", async () => {
    const sent: Array<Record<string, unknown>> = [];
    await provider("claude-sonnet-5", toolReply, sent).invoke({ task: "product_analyzer", input });
    expect(sent[0].thinking).toEqual({ type: "adaptive" });
    expect(sent[0].output_config).toEqual({ effort: "medium" });
    expect(sent[0].max_tokens).toBe(8000);
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
      .invoke({ task: "t", input: { messages: [{ role: "user", content: "x" }] } })
      .catch((e: unknown) => e)) as ProviderError;
    expect(err.code).toBe("output_truncated");
  });

  it("a plain text reply at max_tokens with no tools still returns, with its stop reason", async () => {
    const reply = {
      content: [{ type: "text", text: "partial" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 10, output_tokens: 20 },
    };
    const res = await provider("claude-sonnet-5", reply, []).invoke<AnthropicLLMInput, { stopReason: string }>({
      task: "t",
      input: { messages: [{ role: "user", content: "x" }] },
    });
    expect(res.output.stopReason).toBe("max_tokens");
  });
});
