/**
 * OpenAI Responses adapter: request shape, reply parsing, errors, cost and
 * the image estimate. fetch is always a mock; no network call happens here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmContentBlock, LlmEffort, LlmRequest, LlmResult } from "../llm";
import { InMemoryBreakerStore } from "../breaker";
import { InMemoryCostMeter } from "../meter";
import { ProviderRegistry } from "../registry";
import { callWithFailover } from "../router";
import { MockProvider } from "../testing";
import { AllProvidersFailedError, ProviderError, type ProviderRequest } from "../types";
import { OPENAI_API_KEY_ENV } from "./openaiImage";
import { OPENAI_PATCH_IMAGE_SIZING, OpenaiLLMProvider, openaiImageTokens } from "./openaiLLM";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const PRICES = { inputMicrosPerMTok: 2_000_000, cachedInputMicrosPerMTok: 100_000, outputMicrosPerMTok: 10_000_000 };
const MULTIPLIER = 1.72;

/** A PNG header for a w by h image: enough for imageDimensions. */
function pngBase64(width: number, height: number): string {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return Buffer.from(bytes).toString("base64");
}

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

function replyFetch(reply: unknown, status = 200, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url: String(url), init: init ?? {}, body });
    return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), { status, headers });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function provider(fetchFn: typeof fetch, model = "gpt-test-model") {
  return new OpenaiLLMProvider({
    name: `openai:${model}`,
    tasks: ["intake"],
    apiKey: "test-key",
    model,
    priceTable: PRICES,
    imageTokenMultiplier: MULTIPLIER,
    fetchFn,
  });
}

function req(input: LlmRequest, task = "intake"): ProviderRequest<LlmRequest> {
  return { task, input };
}

const SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string", maxLength: 40 },
    note: { type: "string" },
    styleNotes: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["label", "styleNotes"],
  additionalProperties: false,
};

function completed(text: string, usage: Record<string, unknown> = {}) {
  return {
    id: "resp_1",
    status: "completed",
    output: [
      { type: "reasoning", summary: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] },
    ],
    usage: {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 400 },
      output_tokens: 300,
      output_tokens_details: { reasoning_tokens: 200 },
      ...usage,
    },
  };
}

const IMAGE: LlmContentBlock = { type: "image", mediaType: "image/jpeg", base64: "AAAA" };

describe("OpenaiLLMProvider request", () => {
  it("builds the Responses body exactly as specified", async () => {
    const { fetchFn, calls } = replyFetch(completed('{"label":"mug","styleNotes":null}'));
    await provider(fetchFn).invoke(
      req({
        system: "You are the intake step.",
        messages: [{ role: "user", content: [IMAGE, { type: "text", text: '{"photos":1}' }] }],
        output: { name: "emit_result", schema: SCHEMA, strict: true },
        maxOutputTokens: 16000,
        modelOptions: { "gpt-test-model": { effort: "low" } },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toMatchObject({ authorization: "Bearer test-key", "content-type": "application/json" });
    expect(calls[0].body).toEqual({
      model: "gpt-test-model",
      instructions: "You are the intake step.",
      input: [
        {
          role: "user",
          content: [
            { type: "input_image", image_url: "data:image/jpeg;base64,AAAA", detail: "high" },
            { type: "input_text", text: '{"photos":1}' },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "emit_result",
          strict: true,
          schema: {
            type: "object",
            properties: {
              label: { type: "string" },
              note: { type: ["string", "null"] },
              styleNotes: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
            required: ["label", "note", "styleNotes"],
            additionalProperties: false,
          },
        },
      },
      reasoning: { effort: "low" },
      max_output_tokens: 16000,
      store: false,
    });
  });

  // One request per recipe, with the settings of the Phase 17 model table.
  const recipes: Array<{ key: string; effort: LlmEffort; detail?: "low" | "high"; maxTokens: number }> = [
    { key: "intake_normalizer", effort: "low", detail: "high", maxTokens: 16000 },
    { key: "product_analyzer", effort: "medium", detail: "high", maxTokens: 32000 },
    { key: "shot_planner", effort: "medium", maxTokens: 32000 },
    { key: "copy_generator", effort: "low", maxTokens: 8000 },
    { key: "qc_judge", effort: "low", detail: "high", maxTokens: 8000 },
    { key: "target_picker", effort: "low", detail: "high", maxTokens: 4000 },
    { key: "brand_palette_namer", effort: "none", detail: "low", maxTokens: 2000 },
    { key: "question_planner", effort: "low", detail: "high", maxTokens: 4000 },
  ];
  for (const recipe of recipes) {
    it(`sends ${recipe.key} with store false, no sampling settings and an explicit detail`, async () => {
      const { fetchFn, calls } = replyFetch(completed('{"label":"x","styleNotes":null}'));
      const content: LlmContentBlock[] = recipe.detail
        ? [{ ...IMAGE, detail: recipe.detail }, { type: "text", text: "{}" }]
        : [{ type: "text", text: "{}" }];
      await provider(fetchFn).invoke(
        req(
          {
            system: `system for ${recipe.key}`,
            messages: [{ role: "user", content }],
            output: { name: "emit_result", schema: SCHEMA, strict: true },
            maxOutputTokens: recipe.maxTokens,
            modelOptions: { "gpt-test-model": { effort: recipe.effort } },
          },
          recipe.key,
        ),
      );
      const body = calls[0].body;
      expect(body.store).toBe(false);
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("top_p");
      expect(body.reasoning).toEqual({ effort: recipe.effort });
      expect(body.max_output_tokens).toBe(recipe.maxTokens);
      const parts = (body.input as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
      for (const part of parts.filter((p) => p.type === "input_image")) {
        expect(part.detail).toBe(recipe.detail);
      }
      expect(parts.some((p) => p.type === "input_image")).toBe(recipe.detail !== undefined);
    });
  }

  it("omits reasoning when no effort is set, so the model default applies", async () => {
    const { fetchFn, calls } = replyFetch(completed('{"label":"x","styleNotes":null}'));
    await provider(fetchFn).invoke(
      req({
        system: "s",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        output: { name: "emit_result", schema: SCHEMA, strict: true },
        modelOptions: { "another-model": { effort: "high" } },
      }),
    );
    expect(calls[0].body).not.toHaveProperty("reasoning");
    expect(calls[0].body.max_output_tokens).toBe(25_000);
  });

  it("uses the request wide effort when the model has no entry", async () => {
    const { fetchFn, calls } = replyFetch(completed("{}"));
    await provider(fetchFn).invoke(req({ system: "s", messages: [{ role: "user", content: [] }], effort: "medium" }));
    expect(calls[0].body.reasoning).toEqual({ effort: "medium" });
  });

  it("sends the schema as given when strict is off, and no text format without an output", async () => {
    const strictOff = replyFetch(completed('{"label":"x","styleNotes":null}'));
    await provider(strictOff.fetchFn).invoke(
      req({
        system: "s",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        output: { name: "emit_result", schema: SCHEMA, strict: false },
      }),
    );
    expect(strictOff.calls[0].body.text).toEqual({
      format: { type: "json_schema", name: "emit_result", strict: false, schema: SCHEMA },
    });
    const free = replyFetch(completed("plain words"));
    const res = await provider(free.fetchFn).invoke<LlmRequest, LlmResult>(
      req({ system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    );
    expect(free.calls[0].body).not.toHaveProperty("text");
    expect(res.output).toMatchObject({ json: null, text: "plain words", finish: "complete" });
  });

  it("sends assistant turns as output text", async () => {
    const { fetchFn, calls } = replyFetch(completed("{}"));
    await provider(fetchFn).invoke(
      req({
        system: "s",
        messages: [
          { role: "user", content: [{ type: "text", text: "q" }] },
          { role: "assistant", content: [{ type: "text", text: "a" }] },
        ],
      }),
    );
    expect(calls[0].body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "q" }] },
      { role: "assistant", content: [{ type: "output_text", text: "a" }] },
    ]);
  });

  it("wraps a non object root and unwraps the answer", async () => {
    const { fetchFn, calls } = replyFetch(completed('{"value":["a","b"]}'));
    const res = await provider(fetchFn).invoke<LlmRequest, LlmResult>(
      req({
        system: "s",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        output: { name: "emit_result", schema: { type: "array", items: { type: "string" } }, strict: true },
      }),
    );
    const format = (calls[0].body.text as { format: { schema: Record<string, unknown> } }).format;
    expect(format.schema).toEqual({
      type: "object",
      properties: { value: { type: "array", items: { type: "string" } } },
      required: ["value"],
      additionalProperties: false,
    });
    expect(res.output.json).toEqual(["a", "b"]);
  });

  it("fails closed on a request pinned to a model it does not serve", async () => {
    const { fetchFn, calls } = replyFetch(completed("{}"));
    const p = provider(fetchFn);
    const pinned = req({ system: "s", messages: [], model: "other-model" });
    await expect(p.invoke(pinned)).rejects.toMatchObject({ retryable: false });
    expect(() => p.estimateCostMicros(pinned)).toThrow(/other-model/);
    expect(calls).toHaveLength(0);
  });

  it("needs a key and a positive image multiplier", () => {
    vi.stubEnv(OPENAI_API_KEY_ENV, "");
    const base = { name: "openai:m", tasks: [], model: "m", priceTable: PRICES, imageTokenMultiplier: 1.2 };
    expect(() => new OpenaiLLMProvider(base)).toThrow(/OPENAI_API_KEY/);
    vi.stubEnv(OPENAI_API_KEY_ENV, "env-key");
    expect(new OpenaiLLMProvider(base).kind).toBe("llm");
    expect(() => new OpenaiLLMProvider({ ...base, imageTokenMultiplier: 0 })).toThrow(/imageTokenMultiplier/);
  });
});

describe("OpenaiLLMProvider reply", () => {
  const request = req({
    system: "s",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    output: { name: "emit_result", schema: SCHEMA, strict: true },
    maxOutputTokens: 16000,
  });

  it("parses a completed reply into json, usage and cost", async () => {
    const { fetchFn } = replyFetch(completed('{"label":"mug","note":null,"styleNotes":null}'));
    const res = await provider(fetchFn).invoke<LlmRequest, LlmResult>(request);
    // note was optional, so its null is removed; styleNotes is a required
    // nullable field, so its null is kept.
    expect(res.output.json).toEqual({ label: "mug", styleNotes: null });
    expect(res.output.finish).toBe("complete");
    expect(res.output.text).toBe('{"label":"mug","note":null,"styleNotes":null}');
    expect(res.output.usage).toEqual({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 300, reasoningTokens: 200 });
    // (600 * 2 + 400 * 0.1 + 300 * 10) = 1200 + 40 + 3000 micros.
    expect(res.costMicros).toBe(4240);
  });

  it("joins every output_text part", async () => {
    const reply = completed("");
    reply.output[1].content = [
      { type: "output_text", text: '{"label":', annotations: [] },
      { type: "output_text", text: '"cup","styleNotes":"warm"}', annotations: [] },
    ];
    const { fetchFn } = replyFetch(reply);
    const res = await provider(fetchFn).invoke<LlmRequest, LlmResult>(request);
    expect(res.output.json).toEqual({ label: "cup", styleNotes: "warm" });
  });

  it("returns json null for a structured reply that holds no JSON object", async () => {
    const { fetchFn } = replyFetch(completed("I cannot answer in JSON"));
    const res = await provider(fetchFn).invoke<LlmRequest, LlmResult>(request);
    expect(res.output.json).toBeNull();
  });

  it("turns a refusal into a billed, final content_blocked", async () => {
    const reply = completed("");
    reply.output[1].content = [{ type: "refusal", refusal: "I can't help with that." } as never];
    const { fetchFn } = replyFetch(reply);
    const err = await provider(fetchFn).invoke(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: "content_blocked", retryable: false, transient: false, billedCostMicros: 4240 });
  });

  it("turns an incomplete reply at max_output_tokens into a billed output_truncated", async () => {
    const { fetchFn } = replyFetch({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "reasoning", summary: [] }],
      usage: { input_tokens: 1000, output_tokens: 16000, output_tokens_details: { reasoning_tokens: 16000 } },
    });
    const err = await provider(fetchFn).invoke(request).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "output_truncated", retryable: false, transient: false, billedCostMicros: 162000 });
    expect((err as Error).message).toContain("max_output_tokens (16000)");
  });

  it("turns an incomplete reply from the content filter into content_blocked", async () => {
    const { fetchFn } = replyFetch({
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
      output: [{ type: "message", content: [{ type: "output_text", text: '{"lab' }] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const err = await provider(fetchFn).invoke(request).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "content_blocked", retryable: false, billedCostMicros: 70 });
  });

  it("turns an empty reply into a billed empty_output", async () => {
    const { fetchFn } = replyFetch({ status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 1 } });
    const err = await provider(fetchFn).invoke(request).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "empty_output", retryable: false, billedCostMicros: 30 });
  });

  it("treats a failed response as transient and not retried once billed", async () => {
    const { fetchFn } = replyFetch({
      status: "failed",
      error: { code: "server_error", message: "x" },
      output: [],
      usage: { input_tokens: 10, output_tokens: 0 },
    });
    const err = await provider(fetchFn).invoke(request).catch((e: unknown) => e);
    expect(err).toMatchObject({ retryable: false, transient: true, billedCostMicros: 20 });
  });
});

describe("OpenaiLLMProvider errors", () => {
  const request = req({ system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });

  it.each([
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
  ])("maps the billing code %s to provider_quota", async (code) => {
    const { fetchFn } = replyFetch({ error: { message: "billing", type: "insufficient_quota", code } }, 429);
    const err = await provider(fetchFn).invoke(request).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "provider_quota", retryable: false, transient: false });
  });

  it.each(["rate_limit_exceeded", "slow_down"])("keeps a 429 %s retryable with its Retry-After", async (code) => {
    const { fetchFn } = replyFetch({ error: { message: "slow", type: "requests", code } }, 429, { "retry-after": "2" });
    const err = await provider(fetchFn).invoke(request).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: undefined, retryable: true, transient: true, retryAfterMs: 2000 });
  });

  it("keeps a 503 retryable and reads retry-after-ms", async () => {
    const { fetchFn } = replyFetch({ error: { code: "server_is_overloaded" } }, 503, { "retry-after-ms": "750" });
    const err = await provider(fetchFn).invoke(request).catch((e: unknown) => e);
    expect(err).toMatchObject({ retryable: true, retryAfterMs: 750 });
  });

  it("keeps the responded 400 message the runner's strict retry matches", async () => {
    const { fetchFn } = replyFetch({ error: { message: "Invalid schema", type: "invalid_request_error" } }, 400);
    const err = await provider(fetchFn).invoke(request).catch((e: unknown) => e);
    expect(err).toMatchObject({ retryable: false });
    expect((err as Error).message).toMatch(/^openai:gpt-test-model responded 400\b/);
  });

  it("retries a rate limit through the router, honoring Retry-After within the cap, and never a billing code", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let calls = 0;
    const answers = [
      () => new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), { status: 429, headers: { "retry-after": "3" } }),
      () => new Response(JSON.stringify(completed("{}")), { status: 200 }),
    ];
    const fetchFn = vi.fn(async () => answers[calls++]()) as unknown as typeof fetch;
    const registry = new ProviderRegistry();
    registry.register(provider(fetchFn));
    const sleeps: number[] = [];
    const result = await callWithFailover(
      registry,
      { intake: ["openai:gpt-test-model"] },
      new InMemoryCostMeter(),
      new InMemoryBreakerStore(),
      request,
      { sleep: async (ms) => void sleeps.push(ms), random: () => 0, retry: { retries: 2, baseDelayMs: 100, maxDelayMs: 2500 } },
    );
    expect(result.attempts).toBe(2);
    // Retry-After asked for 3000 ms; the router's cap is 2500.
    expect(sleeps).toEqual([2500]);

    const quotaFetch = vi.fn(
      async () => new Response(JSON.stringify({ error: { code: "credit_balance_exhausted" } }), { status: 429 }),
    ) as unknown as typeof fetch;
    const quotaRegistry = new ProviderRegistry();
    quotaRegistry.register(provider(quotaFetch));
    const fallback = new MockProvider({ name: "anthropic:claude", output: { json: {} }, costMicros: 1 });
    quotaRegistry.register(fallback);
    const failover = await callWithFailover(
      quotaRegistry,
      { intake: ["openai:gpt-test-model", "anthropic:claude"] },
      new InMemoryCostMeter(),
      new InMemoryBreakerStore(),
      { ...request, task: "intake" },
      { sleep: async () => undefined },
    );
    expect(quotaFetch).toHaveBeenCalledTimes(1);
    expect(failover.provider).toBe("anthropic:claude");
  });

  it("reports every billing failure in the chain as provider_quota", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const quotaFetch = vi.fn(
      async () => new Response(JSON.stringify({ error: { code: "project_spend_limit_exceeded" } }), { status: 429 }),
    ) as unknown as typeof fetch;
    const registry = new ProviderRegistry();
    registry.register(provider(quotaFetch));
    const err = await callWithFailover(
      registry,
      { intake: ["openai:gpt-test-model"] },
      new InMemoryCostMeter(),
      new InMemoryBreakerStore(),
      request,
      { sleep: async () => undefined },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect((err as AllProvidersFailedError).errors[0].code).toBe("provider_quota");
  });
});

describe("OpenaiLLMProvider cost estimate", () => {
  it("applies the patch formula with the multiplier", () => {
    // 1024 by 1024: 32 by 32 patches, times 1.72.
    expect(openaiImageTokens(1024, 1024, 1.72)).toBe(Math.ceil(1024 * 1.72));
    expect(openaiImageTokens(1024, 1024, 1.2)).toBe(1229);
    // Partial patches count: 33 px is two patches wide.
    expect(openaiImageTokens(33, 32, 1)).toBe(2);
    // A 4096 by 2048 image fits the 2048 px box first: 2048 by 1024, 64 by 32 patches.
    expect(openaiImageTokens(4096, 2048, 1)).toBe(2048);
    // A 2048 square is 4096 patches, capped at 2500.
    expect(openaiImageTokens(2048, 2048, 1)).toBe(OPENAI_PATCH_IMAGE_SIZING.maxPatches);
    // An unreadable size takes the per image maximum.
    expect(openaiImageTokens(0, 0, 1.72)).toBe(Math.ceil(2500 * 1.72));
  });

  it("prices text, images and the full output budget", () => {
    const p = provider(replyFetch({}).fetchFn);
    const text = req({ system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], maxOutputTokens: 1000 });
    const withImage = req({
      system: "s",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", mediaType: "image/png", base64: pngBase64(1024, 1024) },
            { type: "text", text: "hi" },
          ],
        },
      ],
      maxOutputTokens: 1000,
    });
    const textTokens = p.estimateInputTokens(p.requestBody(text.input, "intake"));
    const imageTokens = p.estimateInputTokens(p.requestBody(withImage.input, "intake"));
    // The image part costs its patch tokens, not its base64 length.
    const imagePartChars = JSON.stringify({ type: "input_image" }).length + 1;
    expect(imageTokens - Math.ceil(imagePartChars / 3)).toBeGreaterThanOrEqual(textTokens + 1762 - 1);
    expect(imageTokens).toBeLessThanOrEqual(textTokens + 1762 + Math.ceil(imagePartChars / 3) + 1);
    expect(p.estimateCostMicros(text)).toBe(Math.ceil((textTokens * 2_000_000 + 1000 * 10_000_000) / 1_000_000));
  });

  it("takes the per image maximum for an unreadable image", () => {
    const p = provider(replyFetch({}).fetchFn);
    const body = p.requestBody(
      { system: "", messages: [{ role: "user", content: [{ type: "image", mediaType: "image/jpeg", base64: "AAAA" }] }] },
      "intake",
    );
    expect(p.estimateInputTokens(body)).toBeGreaterThanOrEqual(Math.ceil(2500 * MULTIPLIER));
  });

  it("meters cached input at its own price", () => {
    const p = provider(replyFetch({}).fetchFn);
    expect(p.costOf({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })).toBe(2_000_000);
    expect(p.costOf({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 })).toBe(100_000);
    expect(p.costOf({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000_000 })).toBe(10_000_000);
    expect(p.costOf({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 })).toBe(2);
  });
});

describe("OpenaiLLMProvider probe", () => {
  it("reads the model resource with a bearer key", async () => {
    const { fetchFn, calls } = replyFetch({ id: "gpt-test-model" });
    const result = await provider(fetchFn).probe();
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(calls[0].url).toBe("https://api.openai.com/v1/models/gpt-test-model");
    expect(calls[0].init).toMatchObject({ method: "GET", headers: { authorization: "Bearer test-key" } });
    expect(calls[0].init.body).toBeUndefined();
  });
});
