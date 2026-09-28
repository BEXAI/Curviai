import { describe, expect, it } from "vitest";
import {
  InMemoryBreakerStore,
  InMemoryCostMeter,
  ProviderRegistry,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
} from "@curvi/ai";
import { coverage, encodePng, solidCanvas, type ImageOutput } from "@curvi/pipeline";
import { CUTOUT_TASK, SCENE_PLATE_TASK, recipeSeedRows } from "@curvi/pipeline/seed";
import type { Shot } from "@curvi/pipeline";
import { alphaMask, LiveShotGenerator, wireLiveProviders, type LiveWiring } from "./live-runtime";
import { demoRoutingTable, DemoShotGenerator } from "./runtime";
import type { PipelineDeps } from "./pipeline-runner";

function freshBase() {
  const registry = new ProviderRegistry();
  const routing = demoRoutingTable();
  return { registry, routing };
}

describe("wireLiveProviders", () => {
  it("activates nothing without env keys", () => {
    const { registry, routing } = freshBase();
    const before = JSON.stringify(routing);
    const wiring = wireLiveProviders(registry, routing, () => undefined);
    expect(wiring.llmLive).toBe(false);
    expect(wiring.imageProviders).toEqual([]);
    expect(wiring.cutoutLive).toBe(false);
    expect(JSON.stringify(routing)).toBe(before);
    expect(registry.list()).toHaveLength(0);
  });

  it("routes every active recipe task to Anthropic when the key is set", () => {
    const { registry, routing } = freshBase();
    const wiring = wireLiveProviders(registry, routing, (name) =>
      name === "ANTHROPIC_API_KEY" ? "key" : undefined,
    );
    expect(wiring.llmLive).toBe(true);
    for (const recipe of recipeSeedRows.filter((r) => r.active)) {
      expect(routing[recipe.key]).toEqual([`anthropic-${recipe.key}`]);
      expect(registry.get(`anthropic-${recipe.key}`)).toBeDefined();
    }
  });

  it("builds the scene plate chain from configured image keys in seed order", () => {
    const { registry, routing } = freshBase();
    const wiring = wireLiveProviders(registry, routing, (name) =>
      name === "GEMINI_API_KEY" || name === "OPENAI_API_KEY" ? "key" : undefined,
    );
    expect(wiring.imageProviders).toEqual(["gemini-image", "openai-image"]);
    expect(routing[SCENE_PLATE_TASK]).toEqual(["gemini-image", "openai-image"]);
    expect(registry.get("gemini-image")?.supports(SCENE_PLATE_TASK)).toBe(true);
  });

  it("registers photoroom for cutouts when its key is set", () => {
    const { registry, routing } = freshBase();
    const wiring = wireLiveProviders(registry, routing, (name) =>
      name === "PHOTOROOM_API_KEY" ? "key" : undefined,
    );
    expect(wiring.cutoutLive).toBe(true);
    expect(routing[CUTOUT_TASK]).toEqual(["photoroom"]);
  });
});

/** RGBA product cutout: transparent canvas with an opaque centered square. */
async function productCutoutPng(size: number): Promise<Buffer> {
  const image = solidCanvas(size, size, 120, 90, 60);
  for (let i = 0; i < size * size; i++) {
    image.data[i * 4 + 3] = 0;
  }
  const start = Math.floor(size * 0.25);
  const end = Math.floor(size * 0.75);
  for (let y = start; y < end; y++) {
    for (let x = start; x < end; x++) {
      image.data[(y * size + x) * 4 + 3] = 255;
    }
  }
  return encodePng(image);
}

class FakeCutoutProvider implements Provider {
  readonly name = "photoroom";
  readonly kind = "cutout" as const;
  constructor(private readonly png: Buffer) {}
  supports(task: string): boolean {
    return task === CUTOUT_TASK;
  }
  async invoke<TIn, TOut>(_req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    return { output: { imageBytes: this.png, contentType: "image/png" } as TOut, costMicros: 20_000 };
  }
}

class FakeSceneProvider implements Provider {
  readonly name = "gemini-image";
  readonly kind = "image" as const;
  calls = 0;
  supports(task: string): boolean {
    return task === SCENE_PLATE_TASK || task === "harmonize";
  }
  async invoke<TIn, TOut>(_req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    this.calls += 1;
    const plate = await encodePng(solidCanvas(64, 64, 245, 244, 240));
    return { output: { png: plate } as ImageOutput as TOut, costMicros: 67_000 };
  }
}

function liveDeps(scene: FakeSceneProvider, cutoutPng: Buffer): { ai: PipelineDeps["ai"]; wiring: LiveWiring } {
  const registry = new ProviderRegistry();
  registry.register(scene);
  registry.register(new FakeCutoutProvider(cutoutPng));
  const routing = {
    [SCENE_PLATE_TASK]: ["gemini-image"],
    harmonize: ["gemini-image"],
    [CUTOUT_TASK]: ["photoroom"],
  };
  return {
    ai: { registry, routing, meter: new InMemoryCostMeter(), breakerStore: new InMemoryBreakerStore() },
    wiring: { llmLive: true, imageProviders: ["gemini-image"], cutoutLive: true },
  };
}

const compositeShotArgs: Shot = {
  id: "shot-1",
  type: "lifestyle",
  sourceMediaId: "ws/demo/src/photo",
  method: "composite_generate",
  channels: ["meta.feed_1x1"],
  stylePreset: "kitchen_lifestyle",
  scene: "morning kitchen counter",
  credits: 1,
  priority: 5,
};

describe("LiveShotGenerator", () => {
  it("composites a live shot with real product pixels and a scene plate", async () => {
    const scene = new FakeSceneProvider();
    const cutout = await productCutoutPng(96);
    const { ai, wiring } = liveDeps(scene, cutout);
    const generator = new LiveShotGenerator({
      ai,
      wiring,
      loadMedia: async () => Buffer.from("source-photo"),
      fallback: new DemoShotGenerator(),
    });

    const generation = await generator.generate({
      shot: compositeShotArgs,
      attempt: 1,
      useFallbackProvider: false,
      jobId: "job-1",
      workspaceId: "ws-1",
    });

    expect(scene.calls).toBe(2);
    expect(generation.encoded.buffer.length).toBeGreaterThan(0);
    expect(generation.productReference).toBeDefined();
    if (!generation.mask) {
      throw new Error("expected a canvas mask on a composite generation");
    }
    expect(coverage(generation.mask)).toBeGreaterThan(0.05);
    expect(generation.costMicros).toBeGreaterThanOrEqual(87_000);
  });

  it("falls back to the demo generator for non composite methods", async () => {
    const scene = new FakeSceneProvider();
    const cutout = await productCutoutPng(96);
    const { ai, wiring } = liveDeps(scene, cutout);
    const generator = new LiveShotGenerator({
      ai,
      wiring,
      loadMedia: async () => Buffer.from("source-photo"),
      fallback: new DemoShotGenerator(),
    });

    const generation = await generator.generate({
      shot: { ...compositeShotArgs, id: "shot-2", type: "amazon_main", method: "deterministic", channels: ["amazon.main"] },
      attempt: 1,
      useFallbackProvider: false,
      jobId: "job-1",
      workspaceId: "ws-1",
    });

    expect(scene.calls).toBe(0);
    expect(generation.encoded.buffer.length).toBeGreaterThan(0);
  });

  it("falls back when the source media is missing", async () => {
    const scene = new FakeSceneProvider();
    const cutout = await productCutoutPng(96);
    const { ai, wiring } = liveDeps(scene, cutout);
    const generator = new LiveShotGenerator({
      ai,
      wiring,
      loadMedia: async () => null,
      fallback: new DemoShotGenerator(),
    });

    const generation = await generator.generate({
      shot: compositeShotArgs,
      attempt: 1,
      useFallbackProvider: false,
      jobId: "job-1",
      workspaceId: "ws-1",
    });

    expect(scene.calls).toBe(0);
    expect(generation.costMicros).toBe(0);
  });
});

describe("alphaMask", () => {
  it("maps opaque pixels to the mask and transparent pixels to background", async () => {
    const png = await productCutoutPng(32);
    const { decodeToRgba } = await import("@curvi/pipeline");
    const rgba = await decodeToRgba(png);
    const mask = alphaMask(rgba);
    const share = coverage(mask);
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.35);
  });
});
