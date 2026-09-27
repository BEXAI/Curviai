/**
 * Adapters are exercised for construction, key resolution, supports() and
 * the pure estimateCostMicros math; endpoint shapes are verified at first
 * live call as noted in each adapter's docstring. No network calls happen
 * here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CostAwareProvider } from "../router";
import type { ProviderRequest } from "../types";
import { AnthropicLLMProvider, ANTHROPIC_API_KEY_ENV } from "./anthropicLLM";
import { BflFluxProvider } from "./bflFlux";
import { FalGatewayProvider } from "./falGateway";
import { GeminiImageProvider } from "./geminiImage";
import { OpenaiImageProvider } from "./openaiImage";
import { PhotoroomCutoutProvider } from "./photoroomCutout";

afterEach(() => {
  vi.unstubAllEnvs();
});

const price = { perImageMicros: 30_000 };
const flat = { perCallMicros: 10_000 };

describe("adapter construction and supports", () => {
  it("constructs the Anthropic adapter with injected model and prices", () => {
    const provider = new AnthropicLLMProvider({
      name: "claude-analyzer",
      tasks: ["analyze_product", "shot_plan"],
      apiKey: "test-key",
      model: "injected-model-id",
      priceTable: { inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000 },
    });
    expect(provider.name).toBe("claude-analyzer");
    expect(provider.kind).toBe("llm");
    expect(provider.supports("analyze_product")).toBe(true);
    expect(provider.supports("generate_image")).toBe(false);
  });

  it("falls back to the environment key at construction", () => {
    vi.stubEnv(ANTHROPIC_API_KEY_ENV, "env-key");
    const provider = new AnthropicLLMProvider({
      name: "claude-analyzer",
      tasks: [],
      model: "injected-model-id",
      priceTable: { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 },
    });
    expect(provider.name).toBe("claude-analyzer");
  });

  it("throws at construction when no key is available", () => {
    vi.stubEnv(ANTHROPIC_API_KEY_ENV, "");
    expect(
      () =>
        new AnthropicLLMProvider({
          name: "claude-analyzer",
          tasks: [],
          model: "injected-model-id",
          priceTable: { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 },
        }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("constructs the Gemini image adapter", () => {
    const provider = new GeminiImageProvider({
      name: "nano-banana-2",
      tasks: ["generate_image", "harmonize"],
      apiKey: "test-key",
      model: "injected-model-id",
      priceTable: price,
    });
    expect(provider.kind).toBe("image");
    expect(provider.supports("harmonize")).toBe(true);
    expect(provider.supports("video_i2v")).toBe(false);
  });

  it("constructs the BFL FLUX adapter", () => {
    const provider = new BflFluxProvider({
      name: "flux2-pro",
      tasks: ["scene_plate"],
      apiKey: "test-key",
      model: "injected-model-path",
      priceTable: price,
    });
    expect(provider.kind).toBe("image");
    expect(provider.supports("scene_plate")).toBe(true);
    expect(provider.supports("analyze_product")).toBe(false);
  });

  it("constructs the OpenAI image adapter", () => {
    const provider = new OpenaiImageProvider({
      name: "openai-image",
      tasks: ["generate_image"],
      apiKey: "test-key",
      model: "injected-model-id",
      priceTable: price,
    });
    expect(provider.kind).toBe("image");
    expect(provider.supports("generate_image")).toBe(true);
  });

  it("constructs the Photoroom cutout adapter", () => {
    const provider = new PhotoroomCutoutProvider({
      name: "photoroom",
      tasks: ["remove_background"],
      apiKey: "test-key",
      priceTable: flat,
    });
    expect(provider.kind).toBe("cutout");
    expect(provider.supports("remove_background")).toBe(true);
    expect(provider.supports("generate_image")).toBe(false);
  });

  it("constructs the fal gateway with an injected kind", () => {
    const provider = new FalGatewayProvider({
      name: "fal-video",
      tasks: ["video_i2v"],
      apiKey: "test-key",
      modelId: "injected/model-path",
      kind: "video",
      priceTable: flat,
    });
    expect(provider.kind).toBe("video");
    expect(provider.supports("video_i2v")).toBe(true);
  });
});

describe("estimateCostMicros", () => {
  it("every adapter exposes estimateCostMicros returning a positive number for a representative request", async () => {
    // Regression for the silent cost cap bypass: the router's maxCostMicros
    // guard only works when adapters can estimate, so every adapter must.
    const cases: Array<{ provider: CostAwareProvider; req: ProviderRequest }> = [
      {
        provider: new AnthropicLLMProvider({
          name: "claude-analyzer",
          tasks: ["analyze_product"],
          apiKey: "test-key",
          model: "injected-model-id",
          priceTable: { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 },
        }),
        req: {
          task: "analyze_product",
          input: { messages: [{ role: "user", content: "describe this ceramic mug" }], maxTokens: 1024 },
        },
      },
      {
        provider: new GeminiImageProvider({
          name: "nano-banana-2",
          tasks: ["generate_image"],
          apiKey: "test-key",
          model: "injected-model-id",
          priceTable: price,
        }),
        req: { task: "generate_image", input: { prompt: "a mug on a table" } },
      },
      {
        provider: new BflFluxProvider({
          name: "flux2-pro",
          tasks: ["scene_plate"],
          apiKey: "test-key",
          model: "injected-model-path",
          priceTable: price,
        }),
        req: { task: "scene_plate", input: { prompt: "a kitchen counter" } },
      },
      {
        provider: new OpenaiImageProvider({
          name: "openai-image",
          tasks: ["generate_image"],
          apiKey: "test-key",
          model: "injected-model-id",
          priceTable: price,
        }),
        req: { task: "generate_image", input: { prompt: "a mug on a table" } },
      },
      {
        provider: new PhotoroomCutoutProvider({
          name: "photoroom",
          tasks: ["remove_background"],
          apiKey: "test-key",
          priceTable: flat,
        }),
        req: { task: "remove_background", input: { imageBytes: new Uint8Array([1, 2, 3]) } },
      },
      {
        provider: new FalGatewayProvider({
          name: "fal-video",
          tasks: ["video_i2v"],
          apiKey: "test-key",
          modelId: "injected/model-path",
          kind: "video",
          priceTable: flat,
        }),
        req: { task: "video_i2v", input: { image_url: "https://example.test/in.png" } },
      },
    ];

    for (const { provider, req } of cases) {
      expect(typeof provider.estimateCostMicros).toBe("function");
      const estimate = await provider.estimateCostMicros?.(req);
      expect(estimate).toBeDefined();
      expect(estimate).toBeGreaterThan(0);
      expect(Number.isFinite(estimate)).toBe(true);
    }
  });

  it("scales the OpenAI image estimate with the requested image count", () => {
    const provider = new OpenaiImageProvider({
      name: "openai-image",
      tasks: ["generate_image"],
      apiKey: "test-key",
      model: "injected-model-id",
      priceTable: price,
    });
    const one = provider.estimateCostMicros({ task: "generate_image", input: { prompt: "mug" } });
    const three = provider.estimateCostMicros({ task: "generate_image", input: { prompt: "mug", n: 3 } });
    expect(one).toBe(price.perImageMicros);
    expect(three).toBe(price.perImageMicros * 3);
  });

  it("bounds the Anthropic estimate by the output token budget", () => {
    const provider = new AnthropicLLMProvider({
      name: "claude-analyzer",
      tasks: ["analyze_product"],
      apiKey: "test-key",
      model: "injected-model-id",
      priceTable: { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 },
    });
    const req: ProviderRequest = {
      task: "analyze_product",
      input: { messages: [{ role: "user", content: "hi" }], maxTokens: 1000 },
    };
    // At least the full output budget priced at the output rate.
    expect(provider.estimateCostMicros(req)).toBeGreaterThanOrEqual(15_000);
  });

  it("sends the recipe selected model and prices it from its own table", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1_000_000, output_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const provider = new AnthropicLLMProvider({
      name: "claude",
      tasks: ["qc"],
      apiKey: "test-key",
      model: "default-model",
      priceTable: { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 5_000_000 },
      priceTables: { "escalation-model": { inputMicrosPerMTok: 4_000_000, outputMicrosPerMTok: 20_000_000 } },
      fetchFn,
    });
    const res = await provider.invoke({
      task: "qc",
      input: { messages: [{ role: "user", content: "judge" }], model: "escalation-model" },
    });
    expect(bodies[0].model).toBe("escalation-model");
    // One million input tokens at the escalation rate, not the default rate.
    expect(res.costMicros).toBe(4_000_000);
  });

  it("fails closed for a recipe model with no price entry", async () => {
    const provider = new AnthropicLLMProvider({
      name: "claude",
      tasks: ["qc"],
      apiKey: "test-key",
      model: "default-model",
      priceTable: { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 5_000_000 },
    });
    await expect(
      provider.invoke({
        task: "qc",
        input: { messages: [{ role: "user", content: "judge" }], model: "unpriced-model" },
      }),
    ).rejects.toThrow(/no price table/);
    expect(() =>
      provider.estimateCostMicros({
        task: "qc",
        input: { messages: [{ role: "user", content: "judge" }], model: "unpriced-model" },
      }),
    ).toThrow(/no price table/);
  });
});
