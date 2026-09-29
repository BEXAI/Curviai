/**
 * Adapters are exercised for construction, key resolution, supports() and
 * the pure estimateCostMicros math; endpoint shapes are verified at first
 * live call as noted in each adapter's docstring. No network calls happen
 * here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CostAwareProvider } from "../router";
import { ProviderError, type ProviderRequest } from "../types";
import {
  ANTHROPIC_IMAGE_TOKEN_LIMITS,
  AnthropicLLMProvider,
  ANTHROPIC_API_KEY_ENV,
  anthropicImageTokens,
} from "./anthropicLLM";
import { BflFluxProvider } from "./bflFlux";
import { FalGatewayProvider } from "./falGateway";
import { GeminiImageProvider } from "./geminiImage";
import { OpenaiImageProvider } from "./openaiImage";
import { PhotoroomCutoutProvider } from "./photoroomCutout";
import { imageDimensions } from "./shared";

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

  it("prices the OpenAI image by requested size, falling back to the flat price", () => {
    const provider = new OpenaiImageProvider({
      name: "openai-image",
      tasks: ["scene_plate"],
      apiKey: "test-key",
      model: "injected-model-id",
      priceTable: { perImageMicros: 53_000, perImageMicrosBySize: { "1024x1024": 53_000, "1536x1024": 41_000 } },
    });
    const est = (input: Record<string, unknown>) => provider.estimateCostMicros({ task: "scene_plate", input });
    expect(est({ prompt: "p", size: "1536x1024" })).toBe(41_000);
    expect(est({ prompt: "p", size: "1024x1024", n: 2 })).toBe(106_000);
    expect(est({ prompt: "p", size: "2048x2048" })).toBe(53_000);
    expect(est({ prompt: "p" })).toBe(53_000);
  });

  it("sends the configured OpenAI quality and meters the size price", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new OpenaiImageProvider({
      name: "openai-image",
      tasks: ["scene_plate"],
      apiKey: "test-key",
      model: "injected-model-id",
      priceTable: { perImageMicros: 53_000, perImageMicrosBySize: { "1536x1024": 41_000 } },
      quality: "medium",
      fetchFn: (async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ data: [{ b64_json: "AAAA" }] }), { status: 200 });
      }) as typeof fetch,
    });
    const res = await provider.invoke({ task: "scene_plate", input: { prompt: "p", size: "1536x1024" } });
    expect(bodies[0].quality).toBe("medium");
    expect(res.costMicros).toBe(41_000);
    await provider.invoke({ task: "scene_plate", input: { prompt: "p", size: "1536x1024", quality: "low" } });
    expect(bodies[1].quality).toBe("low");
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

/** A minimal JPEG: SOI, a large APP1 segment (like EXIF) the parser must
 * skip, an SOF0 header with the given size, filler, EOI. */
function jpegBytes(width: number, height: number, fillerBytes = 0): Uint8Array {
  const app1Length = 0x2000;
  const header = [0xff, 0xd8, 0xff, 0xe1, app1Length >> 8, app1Length & 0xff];
  const app1Body = new Array(app1Length - 2).fill(0x45);
  const sof = [
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff,
    3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  ];
  return new Uint8Array([...header, ...app1Body, ...sof, ...new Array(fillerBytes).fill(0x5a), 0xff, 0xd9]);
}

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
  bytes.set([...Buffer.from("IHDR")], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function webpBytes(chunk: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([...Buffer.from("RIFF")], 0);
  bytes.set([...Buffer.from("WEBP")], 8);
  bytes.set([...Buffer.from(chunk)], 12);
  const view = new DataView(bytes.buffer);
  if (chunk === "VP8 ") {
    bytes.set([0x9d, 0x01, 0x2a], 23);
    view.setUint16(26, width, true);
    view.setUint16(28, height, true);
  } else if (chunk === "VP8L") {
    bytes[20] = 0x2f;
    view.setUint32(21, ((width - 1) | ((height - 1) << 14)) >>> 0, true);
  } else {
    bytes.set([(width - 1) & 0xff, ((width - 1) >> 8) & 0xff, ((width - 1) >> 16) & 0xff], 24);
    bytes.set([(height - 1) & 0xff, ((height - 1) >> 8) & 0xff, ((height - 1) >> 16) & 0xff], 27);
  }
  return bytes;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function anthropic(fetchFn?: typeof fetch) {
  return new AnthropicLLMProvider({
    name: "claude-analyzer",
    tasks: ["analyze_product"],
    apiKey: "test-key",
    model: "injected-model-id",
    priceTable: { inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000 },
    fetchFn,
  });
}

describe("image header parsing", () => {
  it("reads JPEG, PNG, GIF and WebP sizes without decoding", () => {
    expect(imageDimensions(jpegBytes(1568, 1176))).toEqual({ width: 1568, height: 1176 });
    expect(imageDimensions(pngBytes(2000, 1500))).toEqual({ width: 2000, height: 1500 });
    expect(imageDimensions(new Uint8Array([...Buffer.from("GIF89a"), 0x40, 0x01, 0xf0, 0x00]))).toEqual({
      width: 320,
      height: 240,
    });
    expect(imageDimensions(webpBytes("VP8 ", 800, 600))).toEqual({ width: 800, height: 600 });
    expect(imageDimensions(webpBytes("VP8L", 1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(imageDimensions(webpBytes("VP8X", 3000, 2000))).toEqual({ width: 3000, height: 2000 });
  });

  it("returns null for unknown or truncated data", () => {
    expect(imageDimensions(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(imageDimensions(jpegBytes(100, 100).subarray(0, 40))).toBeNull();
    expect(imageDimensions(new Uint8Array(0))).toBeNull();
  });
});

describe("Anthropic image aware cost estimate (Update.md 5.3)", () => {
  it("matches the documented visual token table on the high resolution tier", () => {
    expect(anthropicImageTokens(200, 200)).toBe(64);
    expect(anthropicImageTokens(1000, 1000)).toBe(1296);
    expect(anthropicImageTokens(1092, 1092)).toBe(1521);
    expect(anthropicImageTokens(1920, 1080)).toBe(2691);
    expect(anthropicImageTokens(2000, 1500)).toBe(3888);
    expect(anthropicImageTokens(3840, 2160)).toBe(ANTHROPIC_IMAGE_TOKEN_LIMITS.maxTokens);
  });

  it("stays an upper bound on the standard tier", () => {
    const standard = { patchPx: 28, maxLongEdgePx: 1568, maxTokens: 1568 };
    // The docs list 1560 tokens after downscaling; the estimate never goes under.
    const tokens = anthropicImageTokens(1920, 1080, standard);
    expect(tokens).toBeGreaterThanOrEqual(1560);
    expect(tokens).toBeLessThanOrEqual(1568);
  });

  it("estimates a 1568x1568 photo block at under 5k tokens, not its base64 length", () => {
    const data = b64(jpegBytes(1568, 1568, 300_000));
    expect(data.length).toBeGreaterThan(400_000);
    const photo = { type: "image", source: { type: "base64", media_type: "image/jpeg", data } };
    const text = { type: "text", text: "Describe this ceramic mug." };
    const withPhotos = (count: number) => ({
      messages: [{ role: "user" as const, content: [...new Array(count).fill(photo), text] }],
      maxTokens: 1024,
    });
    const provider = anthropic();

    const tokens = provider.estimateInputTokens(withPhotos(1));
    // 56 by 56 patches of 28 px; the old estimate counted the base64 as
    // text, over 130k tokens for this one photo.
    expect(tokens).toBeGreaterThanOrEqual(56 * 56);
    expect(tokens).toBeLessThan(5_000);

    // Three such photos, as intake and analyze send, reserve cents, not dollars.
    const micros = provider.estimateCostMicros({ task: "analyze_product", input: withPhotos(3) });
    expect(micros).toBeLessThan(50_000);
  });

  it("prices URL, file and unreadable image sources at the per image maximum", () => {
    const provider = anthropic();
    const tokensFor = (source: unknown) =>
      provider.estimateInputTokens({ messages: [{ role: "user", content: [{ type: "image", source }] }] });
    const max = ANTHROPIC_IMAGE_TOKEN_LIMITS.maxTokens;
    expect(tokensFor({ type: "url", url: "https://example.test/a.jpg" })).toBeGreaterThanOrEqual(max);
    expect(tokensFor({ type: "file", file_id: "file_1" })).toBeGreaterThanOrEqual(max);
    expect(tokensFor({ type: "base64", media_type: "image/jpeg", data: "bm90IGFuIGltYWdl" })).toBeGreaterThanOrEqual(max);
    expect(tokensFor({ type: "url", url: "https://example.test/a.jpg" })).toBeLessThan(max + 100);
  });

  it("finds images nested in tool results", () => {
    const provider = anthropic();
    const data = b64(pngBytes(1000, 1000));
    const tokens = provider.estimateInputTokens({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
            },
          ],
        },
      ],
    });
    expect(tokens).toBeGreaterThanOrEqual(1296);
    expect(tokens).toBeLessThan(1296 + 100);
  });

  it("still counts text at one token per three characters", () => {
    const provider = anthropic();
    const text = "x".repeat(3_000);
    const tokens = provider.estimateInputTokens({ messages: [{ role: "user", content: text }] });
    expect(tokens).toBeGreaterThanOrEqual(1_000);
    expect(tokens).toBeLessThan(1_100);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function failureOf(promise: Promise<unknown>): Promise<ProviderError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderError);
  return err as ProviderError;
}

describe("safety blocks and empty replies are final (Update.md 5.4)", () => {
  function gemini(body: unknown) {
    return new GeminiImageProvider({
      name: "nano-banana-2",
      tasks: ["scene_plate"],
      apiKey: "test-key",
      model: "injected-model-id",
      priceTable: price,
      fetchFn: (async () => jsonResponse(body)) as typeof fetch,
    });
  }

  it("Gemini: a prompt blockReason is a non retryable content block", async () => {
    const err = await failureOf(
      gemini({ promptFeedback: { blockReason: "SAFETY" } }).invoke({ task: "scene_plate", input: { prompt: "p" } }),
    );
    expect(err.code).toBe("content_blocked");
    expect(err.retryable).toBe(false);
    expect(err.transient).toBe(false);
    expect(err.message).toContain("SAFETY");
  });

  it("Gemini: an image safety finishReason is a non retryable content block", async () => {
    for (const reason of ["IMAGE_SAFETY", "PROHIBITED_CONTENT", "IMAGE_PROHIBITED_CONTENT"]) {
      const err = await failureOf(
        gemini({ candidates: [{ content: { parts: [{ text: "no" }] }, finishReason: reason }] }).invoke({
          task: "scene_plate",
          input: { prompt: "p" },
        }),
      );
      expect(err.code).toBe("content_blocked");
      expect(err.retryable).toBe(false);
    }
  });

  it("Gemini: a reply with no image and no block reason is a non retryable empty reply", async () => {
    const err = await failureOf(
      gemini({ candidates: [{ content: { parts: [{ text: "here is a description" }] }, finishReason: "STOP" }] }).invoke(
        { task: "scene_plate", input: { prompt: "p" } },
      ),
    );
    expect(err.code).toBe("empty_output");
    expect(err.retryable).toBe(false);
    expect(err.billedCostMicros).toBe(0);
  });

  it("OpenAI: a moderation refusal is a non retryable content block", async () => {
    const provider = new OpenaiImageProvider({
      name: "openai-image",
      tasks: ["scene_plate"],
      apiKey: "test-key",
      model: "injected-model-id",
      priceTable: price,
      fetchFn: (async () =>
        jsonResponse(
          {
            error: {
              type: "image_generation_user_error",
              code: "moderation_blocked",
              message: "Your request was rejected by the safety system.",
            },
          },
          400,
        )) as typeof fetch,
    });
    const err = await failureOf(provider.invoke({ task: "scene_plate", input: { prompt: "p" } }));
    expect(err.code).toBe("content_blocked");
    expect(err.retryable).toBe(false);
  });

  it("OpenAI: an ordinary 400 keeps no content block code", async () => {
    const provider = new OpenaiImageProvider({
      name: "openai-image",
      tasks: ["scene_plate"],
      apiKey: "test-key",
      model: "injected-model-id",
      priceTable: price,
      fetchFn: (async () => jsonResponse({ error: { code: "invalid_size" } }, 400)) as typeof fetch,
    });
    const err = await failureOf(provider.invoke({ task: "scene_plate", input: { prompt: "p" } }));
    expect(err.code).toBeUndefined();
    expect(err.retryable).toBe(false);
  });

  it("OpenAI: an empty data array is a non retryable empty reply", async () => {
    const provider = new OpenaiImageProvider({
      name: "openai-image",
      tasks: ["scene_plate"],
      apiKey: "test-key",
      model: "injected-model-id",
      priceTable: price,
      fetchFn: (async () => jsonResponse({ data: [] })) as typeof fetch,
    });
    const err = await failureOf(provider.invoke({ task: "scene_plate", input: { prompt: "p" } }));
    expect(err.code).toBe("empty_output");
    expect(err.retryable).toBe(false);
  });

  it("Anthropic: a refusal is a non retryable content block that carries its billed tokens", async () => {
    const provider = anthropic((async () =>
      jsonResponse({
        content: [],
        stop_reason: "refusal",
        usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
      })) as typeof fetch);
    const err = await failureOf(
      provider.invoke({ task: "analyze_product", input: { messages: [{ role: "user", content: "hi" }] } }),
    );
    expect(err.code).toBe("content_blocked");
    expect(err.retryable).toBe(false);
    // 1M input at $2 plus 100k output at $10 per million tokens.
    expect(err.billedCostMicros).toBe(3_000_000);
  });

  it("Anthropic: an empty reply is non retryable and carries its billed tokens", async () => {
    const provider = anthropic((async () =>
      jsonResponse({ content: [], stop_reason: "end_turn", usage: { input_tokens: 500_000, output_tokens: 0 } })) as typeof fetch);
    const err = await failureOf(
      provider.invoke({ task: "analyze_product", input: { messages: [{ role: "user", content: "hi" }] } }),
    );
    expect(err.code).toBe("empty_output");
    expect(err.retryable).toBe(false);
    expect(err.billedCostMicros).toBe(1_000_000);
  });
});
