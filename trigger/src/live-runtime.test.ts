import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryBreakerStore,
  InMemoryCapStore,
  InMemoryCostMeter,
  ProviderRegistry,
  SpendCaps,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
} from "@curvi/ai";
import { coverage, encodePng, solidCanvas, type ImageOutput } from "@curvi/pipeline";
import { CUTOUT_TASK, SCENE_PLATE_TASK, recipeSeedRows } from "@curvi/pipeline/seed";
import type { Shot } from "@curvi/pipeline";
import { alphaMask, LiveShotGenerator, upscaleErodePx, wireLiveProviders, type LiveWiring } from "./live-runtime";
import { buildRuntimeDeps, demoRoutingTable } from "./runtime";
import { runGeneratePack, runShot, ShotUnavailableError, type PipelineDeps } from "./pipeline-runner";

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
  calls = 0;
  constructor(private readonly png: Buffer) {}
  supports(task: string): boolean {
    return task === CUTOUT_TASK;
  }
  estimateCostMicros(): number {
    return 20_000;
  }
  async invoke<TIn, TOut>(_req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    this.calls += 1;
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
  estimateCostMicros(): number {
    return 67_000;
  }
  async invoke<TIn, TOut>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    this.calls += 1;
    // Harmonize answers in the draft's shape, as edit models do; compositeShot
    // rejects an output of another aspect ratio (Update.md 2.14).
    const input = req.input as { width?: number; height?: number };
    const height = req.task === "harmonize" && input.width && input.height ? Math.round((64 * input.height) / input.width) : 64;
    const plate = await encodePng(solidCanvas(64, height, 245, 244, 240));
    return { output: { png: plate } as ImageOutput as TOut, costMicros: 67_000 };
  }
}

function liveDeps(
  scene: FakeSceneProvider,
  cutoutPng: Buffer,
  caps?: SpendCaps,
): { ai: PipelineDeps["ai"]; wiring: LiveWiring; cutout: FakeCutoutProvider } {
  const registry = new ProviderRegistry();
  const cutout = new FakeCutoutProvider(cutoutPng);
  registry.register(scene);
  registry.register(cutout);
  const routing = {
    [SCENE_PLATE_TASK]: ["gemini-image"],
    harmonize: ["gemini-image"],
    [CUTOUT_TASK]: ["photoroom"],
  };
  return {
    ai: { registry, routing, meter: new InMemoryCostMeter(), breakerStore: new InMemoryBreakerStore(), caps },
    wiring: { llmLive: true, imageProviders: ["gemini-image"], cutoutLive: true },
    cutout,
  };
}

const compositeShotArgs: Shot = {
  id: "shot-1",
  type: "lifestyle",
  sourceMediaId: "ws/ws-1/src/photo",
  method: "composite_generate",
  channels: ["meta.feed_1x1"],
  stylePreset: "kitchen_lifestyle",
  scene: "morning kitchen counter",
  credits: 1,
  priority: 5,
};

describe("LiveShotGenerator", () => {
  const argsFor = (shot: Shot) => ({ shot, attempt: 1, useFallbackProvider: false, jobId: "job-1", workspaceId: "ws-1" });

  it("composites a live shot with real product pixels and a scene plate", async () => {
    const scene = new FakeSceneProvider();
    const { ai, wiring } = liveDeps(scene, await productCutoutPng(96));
    const generator = new LiveShotGenerator({ ai, wiring, loadMedia: async () => Buffer.from("source-photo") });

    const generation = await generator.generate(argsFor(compositeShotArgs));

    expect(scene.calls).toBe(2);
    expect(generation.encoded.buffer.length).toBeGreaterThan(0);
    expect(generation.productReference).toBeDefined();
    if (!generation.mask) {
      throw new Error("expected a canvas mask on a composite generation");
    }
    expect(coverage(generation.mask)).toBeGreaterThan(0.05);
    expect(generation.costMicros).toBeGreaterThanOrEqual(87_000);
    expect(generation.spendReserved).toBe(false);
  });

  it("never substitutes demo output for methods live providers do not cover (2.1)", async () => {
    const scene = new FakeSceneProvider();
    const { ai, wiring, cutout } = liveDeps(scene, await productCutoutPng(96));
    const generator = new LiveShotGenerator({ ai, wiring, loadMedia: async () => Buffer.from("source-photo") });

    await expect(
      generator.generate(
        argsFor({ ...compositeShotArgs, id: "shot-2", type: "video_hero_6s", method: "video_generate", channels: ["video.social_9x16"] }),
      ),
    ).rejects.toBeInstanceOf(ShotUnavailableError);
    await expect(
      generator.generate(
        argsFor({ ...compositeShotArgs, id: "shot-3", type: "in_the_box", method: "template", channels: ["amazon.secondary"] }),
      ),
    ).rejects.toBeInstanceOf(ShotUnavailableError);
    expect(scene.calls).toBe(0);
    expect(cutout.calls).toBe(0);
  });

  it("renders the white main image from the real cutout without any scene provider", async () => {
    const scene = new FakeSceneProvider();
    const { ai, wiring, cutout } = liveDeps(scene, await productCutoutPng(96));
    const generator = new LiveShotGenerator({ ai, wiring, loadMedia: async () => Buffer.from("source-photo") });

    const generation = await generator.generate(
      argsFor({ ...compositeShotArgs, id: "main-1", type: "amazon_main", method: "deterministic", channels: ["amazon.main"], stylePreset: "none" }),
    );

    expect(scene.calls).toBe(0);
    expect(cutout.calls).toBe(1);
    expect(generation.mask).not.toBeNull();
    expect(generation.encoded.buffer.length).toBeGreaterThan(0);
    expect(generation.costMicros).toBe(20_000);
  });

  it("renders a template still with the shot's callouts", async () => {
    const scene = new FakeSceneProvider();
    const { ai, wiring } = liveDeps(scene, await productCutoutPng(96));
    const generator = new LiveShotGenerator({ ai, wiring, loadMedia: async () => Buffer.from("source-photo") });

    const generation = await generator.generate(
      argsFor({
        ...compositeShotArgs,
        id: "info-1",
        type: "infographic",
        method: "template",
        channels: ["amazon.secondary"],
        stylePreset: "none",
        callouts: ["Keeps drinks hot", "Dishwasher safe", "Fits cup holders"],
      }),
    );

    expect(scene.calls).toBe(0);
    expect(generation.mask).not.toBeNull();
    expect(generation.encoded.buffer.length).toBeGreaterThan(0);
  });

  it("refuses stills that can never render before paying for the cutout", async () => {
    const scene = new FakeSceneProvider();
    const { ai, wiring, cutout } = liveDeps(scene, await productCutoutPng(96));
    const generator = new LiveShotGenerator({ ai, wiring, loadMedia: async () => Buffer.from("source-photo") });
    const template = (id: string, type: Shot["type"], channels: string[], callouts?: string[]) =>
      argsFor({ ...compositeShotArgs, id, type, method: "template", channels, stylePreset: "none", callouts });

    // No text to show.
    await expect(generator.generate(template("t1", "infographic", ["amazon.secondary"], []))).rejects.toThrow(
      /nothing to show/,
    );
    // Text on a channel that forbids it.
    await expect(
      generator.generate(template("t2", "dimensions", ["google.merchant.lifestyle"], ["10 x 10 cm"])),
    ).rejects.toThrow(/does not allow text/);
    // A colored sweep on a plain background channel.
    await expect(
      generator.generate(
        argsFor({ ...compositeShotArgs, id: "t3", type: "sweep_gray", method: "deterministic", channels: ["amazon.main"], stylePreset: "none" }),
      ),
    ).rejects.toThrow(/plain background/);
    expect(cutout.calls).toBe(0);
  });

  it("cuts each source photo out once per job and charges it to the first shot only", async () => {
    const scene = new FakeSceneProvider();
    const { ai, wiring, cutout } = liveDeps(scene, await productCutoutPng(96));
    const generator = new LiveShotGenerator({ ai, wiring, loadMedia: async () => Buffer.from("source-photo") });
    const deterministic = (id: string, type: Shot["type"], channels: string[]) =>
      argsFor({ ...compositeShotArgs, id, type, method: "deterministic", channels, stylePreset: "none" });

    const [first, second] = await Promise.all([
      generator.generate(deterministic("a", "amazon_main", ["amazon.main"])),
      generator.generate(deterministic("b", "sweep_gray", ["amazon.secondary"])),
    ]);

    expect(cutout.calls).toBe(1);
    expect(first.costMicros + second.costMicros).toBe(20_000);
  });

  it("reports a missing source photo as unavailable instead of faking one", async () => {
    const scene = new FakeSceneProvider();
    const { ai, wiring, cutout } = liveDeps(scene, await productCutoutPng(96));
    const generator = new LiveShotGenerator({ ai, wiring, loadMedia: async () => null });

    await expect(generator.generate(argsFor(compositeShotArgs))).rejects.toBeInstanceOf(ShotUnavailableError);
    expect(scene.calls).toBe(0);
    expect(cutout.calls).toBe(0);
  });

  it("is unavailable when storage is not configured", async () => {
    const scene = new FakeSceneProvider();
    const { ai, wiring } = liveDeps(scene, await productCutoutPng(96));
    const generator = new LiveShotGenerator({ ai, wiring, loadMedia: null });

    await expect(generator.generate(argsFor(compositeShotArgs))).rejects.toBeInstanceOf(ShotUnavailableError);
  });

  it("never loads a source key outside the workspace prefix", async () => {
    const scene = new FakeSceneProvider();
    const { ai, wiring } = liveDeps(scene, await productCutoutPng(96));
    const loaded: string[] = [];
    const generator = new LiveShotGenerator({
      ai,
      wiring,
      loadMedia: async (key) => {
        loaded.push(key);
        return Buffer.from("source-photo");
      },
    });

    await expect(
      generator.generate(argsFor({ ...compositeShotArgs, sourceMediaId: "ws/other-tenant/src/photo" })),
    ).rejects.toBeInstanceOf(ShotUnavailableError);
    expect(loaded).toEqual([]);
  });

  it("reserves spend against the caps before each provider call (5.2)", async () => {
    const scene = new FakeSceneProvider();
    const store = new InMemoryCapStore();
    const caps = new SpendCaps(store, () => new Date("2026-09-28T12:00:00Z"));
    const { ai, wiring } = liveDeps(scene, await productCutoutPng(96), caps);
    const generator = new LiveShotGenerator({ ai, wiring, loadMedia: async () => Buffer.from("source-photo") });

    const generation = await generator.generate(argsFor(compositeShotArgs));

    expect(generation.spendReserved).toBe(true);
    // Cutout plus scene plate plus harmonize, reconciled to the actual cost.
    expect(await store.get("caps:asset:image:shot-1")).toBe(generation.costMicros);
    expect(await store.get("caps:pack:job-1")).toBe(generation.costMicros);
    expect(await store.get("caps:global:2026-09-28")).toBe(generation.costMicros);
  });

  it("stops before spending when the global hard stop would be crossed", async () => {
    const scene = new FakeSceneProvider();
    const store = new InMemoryCapStore();
    // Room for the cutout estimate, not for the scene plate after it.
    const caps = new SpendCaps(store, () => new Date("2026-09-28T12:00:00Z"), { globalDailyHardStopMicros: 50_000 });
    const { ai, wiring, cutout } = liveDeps(scene, await productCutoutPng(96), caps);
    const generator = new LiveShotGenerator({ ai, wiring, loadMedia: async () => Buffer.from("source-photo") });

    await expect(generator.generate(argsFor(compositeShotArgs))).rejects.toBeInstanceOf(ShotUnavailableError);
    expect(cutout.calls).toBe(1);
    expect(scene.calls).toBe(0);
    expect(await store.get("caps:global:2026-09-28")).toBeLessThanOrEqual(50_000);
  });

  it("does not call the cutout provider at all when it alone would cross the cap", async () => {
    const scene = new FakeSceneProvider();
    const caps = new SpendCaps(new InMemoryCapStore(), () => new Date(), { globalDailyHardStopMicros: 10_000 });
    const { ai, wiring, cutout } = liveDeps(scene, await productCutoutPng(96), caps);
    const generator = new LiveShotGenerator({ ai, wiring, loadMedia: async () => Buffer.from("source-photo") });

    await expect(generator.generate(argsFor(compositeShotArgs))).rejects.toBeInstanceOf(ShotUnavailableError);
    expect(cutout.calls).toBe(0);
    expect(scene.calls).toBe(0);
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

describe("buildRuntimeDeps generator selection (real credits)", () => {
  const keys = ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "BFL_API_KEY", "OPENAI_API_KEY", "PHOTOROOM_API_KEY"];
  const shotArgs = {
    shot: { ...compositeShotArgs, type: "amazon_main" as const, method: "deterministic" as const, channels: ["amazon.main"] },
    attempt: 1,
    useFallbackProvider: false,
    jobId: "job-1",
    workspaceId: "ws-1",
  };

  beforeEach(() => {
    for (const key of keys) vi.stubEnv(key, "");
    vi.stubEnv("CURVI_ALLOW_DEMO_GENERATION", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the demo generator for demo mode and tests", async () => {
    const deps = buildRuntimeDeps();
    const generation = await deps.generator.generate(shotArgs);
    expect(generation.encoded.buffer.length).toBeGreaterThan(0);
  });

  it("never charges for demo placeholders when credits are real, even with no keys", async () => {
    const deps = buildRuntimeDeps({ realCredits: true });
    await expect(deps.generator.generate(shotArgs)).rejects.toBeInstanceOf(ShotUnavailableError);
  });

  it("lets local db development opt back into the demo generator explicitly", async () => {
    vi.stubEnv("CURVI_ALLOW_DEMO_GENERATION", "1");
    const deps = buildRuntimeDeps({ realCredits: true });
    const generation = await deps.generator.generate(shotArgs);
    expect(generation.encoded.buffer.length).toBeGreaterThan(0);
  });
});

describe("a live pack end to end (fake providers, real renderers)", () => {
  it("delivers every still shot type from the real cutout and charges only what shipped", async () => {
    const deps = buildRuntimeDeps();
    const scene = new FakeSceneProvider();
    const cutout = new FakeCutoutProvider(await productCutoutPng(160));
    deps.ai.registry.register(scene);
    deps.ai.registry.register(cutout);
    deps.ai.routing[SCENE_PLATE_TASK] = ["gemini-image"];
    deps.ai.routing.harmonize = ["gemini-image"];
    deps.ai.routing[CUTOUT_TASK] = ["photoroom"];
    const generator = new LiveShotGenerator({
      ai: deps.ai,
      wiring: { llmLive: false, imageProviders: ["gemini-image"], cutoutLive: true },
      loadMedia: async () => Buffer.from("source-photo"),
    });

    const summary = await runGeneratePack(
      {
        jobId: "job-live",
        workspaceId: "ws1",
        tier: "starter",
        channels: ["amazon", "shopify", "meta"],
        creditBudget: 60,
        images: [{ mediaId: "ws/ws1/src/photo" }],
        sku: "MUG1",
        seoSlug: "ceramic-mug",
        brandColors: ["#1A5F7A"],
      },
      { ...deps, generator, excludeShotMethods: ["video_generate", "avatar"] },
    );

    expect(summary.state).toBe("done");
    const store = deps.store as unknown as { assets: Array<{ shotType: string; status: string; verdict: { repairHint: string } }> };
    const passedTypes = new Set(store.assets.filter((a) => a.status === "passed").map((a) => a.shotType));
    for (const type of ["amazon_main", "alt_angle_white", "sweep_gray", "sweep_brand", "lifestyle", "infographic", "aplus_banner", "collection_thumb", "social_1x1", "social_4x5", "social_9x16"]) {
      if (store.assets.some((a) => a.shotType === type)) {
        expect(passedTypes, `${type} should pass in a live pack`).toContain(type);
      }
    }
    expect(passedTypes).toContain("amazon_main");
    // One Photoroom call for the whole pack: every shot shares the cutout.
    expect(cutout.calls).toBe(1);
    expect(summary.pack?.files).toBe(summary.passed);
    expect(summary.chargedCredits).toBeGreaterThan(0);
  });
});

/** Small textured cutout: seeded noise and gradients inside an ellipse. */
async function texturedCutoutPng(width: number, height: number): Promise<Buffer> {
  const image = solidCanvas(width, height, 0, 0, 0, 0);
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // A small product in the frame (about 18x upscale to the main image)
      // with full range noise: the worst case for the resize edge band.
      const dx = (x - width / 2) / (width * 0.2);
      const dy = (y - height / 2) / (height * 0.2);
      if (dx * dx + dy * dy > 1) continue;
      const i = (y * width + x) * 4;
      image.data[i] = Math.round(rand() * 255);
      image.data[i + 1] = Math.round(rand() * 255);
      image.data[i + 2] = Math.round(rand() * 255);
      image.data[i + 3] = 255;
    }
  }
  return encodePng(image);
}

describe("rule 3 on live stills", () => {
  it("proves the product pixels of an upscaled small cutout through the runner's fidelity gate", async () => {
    const deps = buildRuntimeDeps();
    const scene = new FakeSceneProvider();
    const cutout = new FakeCutoutProvider(await texturedCutoutPng(240, 180));
    deps.ai.registry.register(scene);
    deps.ai.registry.register(cutout);
    deps.ai.routing[CUTOUT_TASK] = ["photoroom"];
    const generator = new LiveShotGenerator({
      ai: deps.ai,
      wiring: { llmLive: false, imageProviders: ["gemini-image"], cutoutLive: true },
      loadMedia: async () => Buffer.from("source-photo"),
    });
    const shot: Shot = { ...compositeShotArgs, id: "main-up", type: "amazon_main", method: "deterministic", channels: ["amazon.main"], stylePreset: "none" };

    const outcome = await runShot(shot, { jobId: "job-up", workspaceId: "ws-1" }, { ...deps, generator });

    expect(outcome.fidelityPass).toBe(true);
    expect(outcome.status).toBe("passed");
  });

  it("widens the erosion only when the product was scaled up", () => {
    const mask = (w: number, h: number) => ({ data: Buffer.alloc(w * h, 255), width: w, height: h });
    expect(upscaleErodePx(mask(100, 100), mask(100, 100))).toBeUndefined();
    expect(upscaleErodePx(mask(100, 100), mask(50, 50))).toBeUndefined();
    expect(upscaleErodePx(mask(100, 100), mask(1200, 1200))).toBe(37);
  });
});
