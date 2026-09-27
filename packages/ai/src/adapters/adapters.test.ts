/**
 * Adapters are exercised for construction, key resolution and supports()
 * only; endpoint shapes are verified at first live call as noted in each
 * adapter's docstring. No network calls happen here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
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
