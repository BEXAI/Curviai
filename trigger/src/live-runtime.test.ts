import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASYNC_JOB_TIMEOUT_MARGIN_MS,
  BflFluxProvider,
  callWithFailover,
  imageDimensions,
  InMemoryBreakerStore,
  InMemoryCapStore,
  InMemoryCostMeter,
  ProviderError,
  ProviderRegistry,
  SpendCaps,
  type CostAwareProvider,
  type GeminiImageInput,
  type PhotoroomCutoutInput,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
} from "@curvi/ai";
import { coverage, encodePng, rawToSharp, solidCanvas, type ImageOutput } from "@curvi/pipeline";
import {
  CUTOUT_TASK,
  HARMONIZE_TASK,
  SCENE_PLATE_TASK,
  canvasDefaults,
  llmModelPrices,
  recipeSeedRows,
  sceneDefaults,
  templates,
} from "@curvi/pipeline/seed";
import { GeminiImageProvider } from "@curvi/ai";
import type { Shot } from "@curvi/pipeline";
import {
  alphaMask,
  guardScenePlate,
  HARMONIZE_SHAPE_REFUSED,
  LiveShotGenerator,
  MAX_CUTOUT_COVERAGE,
  nearestGeminiAspectRatio,
  ScenePlateBridge,
  segmentationRefusal,
  upscaleErodePx,
  wireLiveProviders,
  type LiveWiring,
} from "./live-runtime";
import { llmModelProviderName } from "./recipes";
import { buildRuntimeDeps, demoRoutingTable } from "./runtime";
import {
  runGeneratePack,
  runShot,
  SHOT_CONTENT_BLOCKED,
  SHOT_PROVIDER_TROUBLE,
  ShotFailedAfterSpendError,
  ShotUnavailableError,
  type PipelineDeps,
} from "./pipeline-runner";

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

  it("routes every active recipe task to its seeded Anthropic model chain when the key is set", () => {
    const { registry, routing } = freshBase();
    const wiring = wireLiveProviders(registry, routing, (name) =>
      name === "ANTHROPIC_API_KEY" ? "key" : undefined,
    );
    expect(wiring.llmLive).toBe(true);
    // One provider per priced model, each serving every recipe task.
    for (const model of Object.keys(llmModelPrices)) {
      const provider = registry.get(llmModelProviderName(model));
      expect(provider).toBeDefined();
      for (const recipe of recipeSeedRows) {
        expect(provider?.supports(recipe.key)).toBe(true);
      }
    }
    for (const recipe of recipeSeedRows.filter((r) => r.active)) {
      expect(routing[recipe.key]).toEqual(
        [recipe.model, ...(recipe.fallbackModels ?? [])].map(llmModelProviderName),
      );
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
  /** Scene plate prompts in call order. */
  readonly prompts: string[] = [];
  supports(task: string): boolean {
    return task === SCENE_PLATE_TASK || task === "harmonize";
  }
  estimateCostMicros(): number {
    return 67_000;
  }
  async invoke<TIn, TOut>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    this.calls += 1;
    if (req.task === SCENE_PLATE_TASK) {
      this.prompts.push((req.input as unknown as { prompt: string }).prompt);
    }
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
    // Secondary shots ship to both Amazon and Shopify, so there are more
    // files than charged shots.
    expect(summary.pack?.files).toBeGreaterThan(summary.passed);
    expect(summary.chargedCredits).toBeGreaterThan(0);
    // Each lifestyle scene was generated once (scene plate plus harmonize)
    // and derived for its other channel without another provider call.
    const lifestyleShots = store.assets.filter((a) => a.shotType === "lifestyle" && a.status === "passed").length;
    const heroShots = store.assets.filter((a) => a.shotType === "shopify_hero" && a.status === "passed").length;
    expect(scene.calls).toBe(2 * (lifestyleShots + heroShots));
    // Every channel output renders and is checked at full size, so this pack
    // needs more than the default per test budget.
  }, 120_000);
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

describe("segmentation guard (2.13)", () => {
  /** A cutout where the background came back as product: fully opaque. */
  async function opaqueCutoutPng(size: number): Promise<Buffer> {
    return encodePng(solidCanvas(size, size, 120, 90, 60, 255));
  }
  const maskOf = (width: number, height: number, on: (x: number, y: number) => boolean) => {
    const data = Buffer.alloc(width * height, 0);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (on(x, y)) data[y * width + x] = 255;
    return { data, width, height };
  };

  it("refuses empty, near full and four border masks, and accepts a normal product", () => {
    expect(segmentationRefusal(maskOf(40, 40, () => false))).toContain("found no product");
    expect(segmentationRefusal(maskOf(40, 40, () => true))).toContain("could not separate the product");
    expect(MAX_CUTOUT_COVERAGE).toBe(0.95);
    // A cross touching every border covers far less than 95 percent.
    const cross = maskOf(40, 40, (x, y) => Math.abs(x - 20) < 3 || Math.abs(y - 20) < 3);
    expect(segmentationRefusal(cross)).toContain("could not separate the product");
    // Touching three borders is a product cropped by the frame, not a failure.
    const threeSides = maskOf(40, 40, (x, y) => y > 10 && x > 5 && x < 34 ? true : y > 30);
    expect(segmentationRefusal(threeSides)).toBeNull();
    expect(segmentationRefusal(maskOf(40, 40, (x, y) => x > 8 && x < 30 && y > 8 && y < 30))).toBeNull();
  });

  it("sends every shot of a photo whose cutout failed to review, paying for the cutout once", async () => {
    const scene = new FakeSceneProvider();
    const { ai, wiring, cutout } = liveDeps(scene, await opaqueCutoutPng(64));
    const generator = new LiveShotGenerator({ ai, wiring, loadMedia: async () => Buffer.from("source-photo") });
    const main = { ...compositeShotArgs, id: "m", type: "amazon_main" as const, method: "deterministic" as const, channels: ["amazon.main"], stylePreset: "none" };
    const args = (shot: Shot) => ({ shot, attempt: 1, useFallbackProvider: false, jobId: "job-seg", workspaceId: "ws-1" });

    const first = await generator.generate(args(main)).catch((err: unknown) => err);
    expect(first).toBeInstanceOf(ShotUnavailableError);
    expect((first as ShotUnavailableError).message).toBe(
      "We could not separate the product from its background in this photo, so this shot needs review.",
    );
    expect((first as ShotUnavailableError).costMicros).toBe(20_000);
    const second = await generator.generate(args(compositeShotArgs)).catch((err: unknown) => err);
    expect(second).toBeInstanceOf(ShotUnavailableError);
    expect((second as ShotUnavailableError).costMicros).toBe(0);
    expect(cutout.calls).toBe(1);
    expect(scene.calls).toBe(0);
  });

  it("never ships or charges the photo rectangle as the product", async () => {
    const deps = buildRuntimeDeps();
    const scene = new FakeSceneProvider();
    const cutout = new FakeCutoutProvider(await opaqueCutoutPng(64));
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
        jobId: "job-seg-pack",
        workspaceId: "ws1",
        tier: "starter",
        channels: ["amazon"],
        creditBudget: 20,
        images: [{ mediaId: "ws/ws1/src/photo" }],
        sku: "SKU",
      },
      { ...deps, generator, excludeShotMethods: ["video_generate", "avatar"] },
    );

    expect(summary.passed).toBe(0);
    expect(summary.chargedCredits).toBe(0);
    expect(summary.releasedCredits).toBe(20);
    expect(summary.state).toBe("failed");
    expect(cutout.calls).toBe(1);
    expect(scene.calls).toBe(0);
    const store = deps.store as unknown as { assets: Array<{ status: string; verdict: { repairHint: string } }> };
    expect(store.assets.length).toBeGreaterThan(0);
    expect(store.assets.every((a) => a.status === "needs_review")).toBe(true);
    expect(store.assets.some((a) => a.verdict.repairHint.includes("could not separate the product"))).toBe(true);
  });
});

describe("Gemini plate shape (2.14)", () => {
  it("maps canvases onto the nearest aspect ratio Gemini accepts", () => {
    expect(nearestGeminiAspectRatio(2000, 2000)).toBe("1:1");
    expect(nearestGeminiAspectRatio(2400, 1000)).toBe("21:9");
    expect(nearestGeminiAspectRatio(1080, 1350)).toBe("4:5");
    expect(nearestGeminiAspectRatio(1080, 1920)).toBe("9:16");
    expect(nearestGeminiAspectRatio(1000, 1500)).toBe("2:3");
    expect(nearestGeminiAspectRatio(970, 600)).toBe("3:2");
  });

  it("sends the aspect ratio in generationConfig.imageConfig for plates and harmonization", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const png = await encodePng(solidCanvas(8, 8, 200, 200, 200));
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png.toString("base64") } }] } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const inner = new GeminiImageProvider({
      name: "gemini-image-api",
      tasks: [SCENE_PLATE_TASK, HARMONIZE_TASK],
      apiKey: "test-key",
      model: "test-model",
      priceTable: { perImageMicros: 1 },
      fetchFn,
    });
    const bridge = new ScenePlateBridge(inner, "gemini", "gemini-image");

    await bridge.invoke({ task: SCENE_PLATE_TASK, input: { prompt: "plate", width: 2400, height: 1000 } });
    const square = await encodePng(solidCanvas(64, 64, 10, 10, 10));
    await bridge.invoke({ task: HARMONIZE_TASK, input: { prompt: "light", png: square } });

    const configs = bodies.map((b) => b.generationConfig as { responseModalities: string[]; imageConfig?: { aspectRatio?: string } });
    expect(configs[0]).toEqual({ responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "21:9" } });
    expect(configs[1].imageConfig?.aspectRatio).toBe("1:1");
  });
});

describe("scene prompts come from the seeded templates (7.4)", () => {
  const argsFor = (shot: Shot, repairHint?: string) => ({
    shot,
    attempt: repairHint ? 2 : 1,
    repairHint,
    useFallbackProvider: false,
    jobId: "job-prompts",
    workspaceId: "ws-1",
  });

  it("appends the repair hint through the lifestyle template", async () => {
    const scene = new FakeSceneProvider();
    const { ai, wiring } = liveDeps(scene, await productCutoutPng(96));
    const generator = new LiveShotGenerator({ ai, wiring, loadMedia: async () => Buffer.from("source-photo") });

    await generator.generate(argsFor(compositeShotArgs, "Soften the shadow under the mug"));

    expect(scene.prompts).toEqual([
      templates.lifestyle_plate_flux2({
        scene: "morning kitchen counter",
        preset: "kitchen_lifestyle",
        repairHint: "Soften the shadow under the mug",
      }),
    ]);
    expect(scene.prompts[0]).toContain("Soften the shadow under the mug");
  });

  it("falls back to the seeded scene and preset, and adds no repair text on a first attempt", async () => {
    const scene = new FakeSceneProvider();
    const { ai, wiring } = liveDeps(scene, await productCutoutPng(96));
    const generator = new LiveShotGenerator({ ai, wiring, loadMedia: async () => Buffer.from("source-photo") });
    const bare: Shot = { ...compositeShotArgs, scene: undefined, stylePreset: "not_a_preset" };

    await generator.generate(argsFor(bare));

    const expected = templates.lifestyle_plate_flux2({
      scene: templates.scene_fallback({ shotLabel: "lifestyle" }),
      preset: sceneDefaults.preset,
    });
    expect(scene.prompts).toEqual([expected]);
    expect(expected).not.toContain("Repair instruction");
  });

  it("sizes open channel canvases from the seeded default", async () => {
    const scene = new FakeSceneProvider();
    const { ai, wiring } = liveDeps(scene, await productCutoutPng(96));
    const generator = new LiveShotGenerator({ ai, wiring, loadMedia: async () => Buffer.from("source-photo") });
    const generation = await generator.generate(
      argsFor({ ...compositeShotArgs, channels: ["google.merchant.lifestyle"] }),
    );
    expect(generation.image.width).toBe(canvasDefaults.width);
    expect(generation.image.height).toBe(canvasDefaults.width);
  });
});

/**
 * Gemini shaped inner adapter for ScenePlateBridge tests: plates come back
 * square; harmonization comes back in the draft's shape, or squashed to half
 * its height when wrongShape is set.
 */
class FakeGeminiInner implements CostAwareProvider {
  readonly kind = "image" as const;
  readonly tasks: string[] = [];
  constructor(
    readonly name: string,
    private readonly wrongShape: boolean,
    private readonly fail?: () => Error,
  ) {}
  supports(): boolean {
    return true;
  }
  estimateCostMicros(): number {
    return 67_000;
  }
  async invoke<TIn, TOut>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    this.tasks.push(req.task);
    if (this.fail) throw this.fail();
    const input = req.input as unknown as GeminiImageInput;
    let width = 64;
    let height = 64;
    const draft = input.images?.[0];
    if (draft) {
      const size = imageDimensions(Buffer.from(draft.dataBase64, "base64"));
      width = size?.width ?? 64;
      height = Math.round((size?.height ?? 64) / (this.wrongShape ? 2 : 1));
    }
    const png = await encodePng(solidCanvas(width, height, 245, 244, 240));
    return {
      output: { images: [{ mimeType: "image/png", dataBase64: png.toString("base64") }], raw: {} } as TOut,
      costMicros: 67_000,
    };
  }
}

/** Live deps whose scene chain is guarded bridges around the given inners. */
function bridgedDeps(inners: FakeGeminiInner[], cutoutPng: Buffer, caps?: SpendCaps) {
  const registry = new ProviderRegistry();
  const cutout = new FakeCutoutProvider(cutoutPng);
  registry.register(cutout);
  for (const inner of inners) {
    registry.register(guardScenePlate(new ScenePlateBridge(inner, "gemini", inner.name)));
  }
  const chain = inners.map((i) => i.name);
  const meter = new InMemoryCostMeter();
  const ai: PipelineDeps["ai"] = {
    registry,
    routing: { [SCENE_PLATE_TASK]: chain, [HARMONIZE_TASK]: chain, [CUTOUT_TASK]: ["photoroom"] },
    meter,
    breakerStore: new InMemoryBreakerStore(),
    caps,
  };
  const wiring: LiveWiring = { llmLive: true, imageProviders: chain, cutoutLive: true };
  return { ai, wiring, meter, cutout };
}

describe("harmonize shape guard in the provider chain (2.14)", () => {
  const argsFor = (shot: Shot) => ({ shot, attempt: 1, useFallbackProvider: false, jobId: "job-h", workspaceId: "ws-1" });

  it("fails over to the next image provider when one returns the lighting pass in the wrong shape", async () => {
    const wrong = new FakeGeminiInner("gemini-image", true);
    const right = new FakeGeminiInner("flux-image", false);
    const { ai, wiring, meter } = bridgedDeps([wrong, right], await productCutoutPng(96));
    const generator = new LiveShotGenerator({ ai, wiring, loadMedia: async () => Buffer.from("source-photo") });

    const generation = await generator.generate(argsFor(compositeShotArgs));

    expect(wrong.tasks).toEqual([SCENE_PLATE_TASK, HARMONIZE_TASK]);
    expect(right.tasks).toEqual([HARMONIZE_TASK]);
    expect(generation.productReference).toBeDefined();
    const rejected = meter.entries.find((e) => e.provider === "gemini-image" && e.task === HARMONIZE_TASK);
    expect(rejected?.ok).toBe(false);
    expect(rejected?.error).toContain("does not match");
    // Cutout, plate and the accepted harmonization at least.
    expect(generation.costMicros).toBeGreaterThanOrEqual(20_000 + 2 * 67_000);
  });

  it("sends only that shot to review, with its spend, when every provider returns the wrong shape", async () => {
    const wrong = new FakeGeminiInner("gemini-image", true);
    const { ai, wiring } = bridgedDeps([wrong], await productCutoutPng(96));
    const generator = new LiveShotGenerator({ ai, wiring, loadMedia: async () => Buffer.from("source-photo") });

    const err = await generator.generate(argsFor(compositeShotArgs)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShotUnavailableError);
    expect((err as ShotUnavailableError).message).toBe(HARMONIZE_SHAPE_REFUSED);
    // The cutout, the plate and the rejected but paid harmonization.
    expect((err as ShotUnavailableError).costMicros).toBe(20_000 + 67_000 + 67_000);

    const outcome = await runShot(
      { ...compositeShotArgs, id: "shot-h2" },
      { jobId: "job-h2", workspaceId: "ws-1" },
      { ...buildRuntimeDeps(), generator: new LiveShotGenerator({ ai, wiring, loadMedia: async () => Buffer.from("source-photo") }) },
    );
    expect(outcome.status).toBe("needs_review");
    expect(outcome.verdict.repairHint).toBe(HARMONIZE_SHAPE_REFUSED);
    expect(outcome.costMicros).toBe(20_000 + 67_000 + 67_000);
  });

  it("keeps the bridge's timeout floor and cost estimate behind the guard", () => {
    const bridge = new ScenePlateBridge(new FakeGeminiInner("gemini-image", false), "gemini", "gemini-image");
    const guarded = guardScenePlate(bridge);
    expect(guarded.minTimeoutMs).toBe(bridge.minTimeoutMs);
    expect(guarded.estimateCostMicros?.({ task: HARMONIZE_TASK, input: {} })).toBe(67_000);
    expect(guarded.supports(SCENE_PLATE_TASK)).toBe(true);
  });

  it("registers every live image bridge behind the guard", () => {
    const { registry, routing } = freshBase();
    wireLiveProviders(registry, routing, (name) => (name === "GEMINI_API_KEY" ? "key" : undefined));
    const registered = registry.get("gemini-image") as CostAwareProvider;
    expect(registered).toBeDefined();
    expect(registered).not.toBeInstanceOf(ScenePlateBridge);
    expect(registered.minTimeoutMs).toBe(ASYNC_JOB_TIMEOUT_MARGIN_MS);
  });
});

describe("ScenePlateBridge timeouts and downloads (5.1)", () => {
  it("adds a download margin to the inner adapter's timeout floor", () => {
    const bfl = new BflFluxProvider({
      name: "flux-api",
      tasks: [SCENE_PLATE_TASK],
      apiKey: "key",
      model: "flux-test",
      priceTable: { perImageMicros: 1 },
      pollTimeoutMs: 120_000,
    });
    const bflBridge = new ScenePlateBridge(bfl, "bfl", "flux-image");
    expect(bflBridge.minTimeoutMs).toBe(bfl.minTimeoutMs + ASYNC_JOB_TIMEOUT_MARGIN_MS);
    expect(bflBridge.minTimeoutMs).toBeGreaterThan(120_000);
    const sync = new ScenePlateBridge(new FakeGeminiInner("gemini-image", false), "gemini", "gemini-image");
    expect(sync.minTimeoutMs).toBe(ASYNC_JOB_TIMEOUT_MARGIN_MS);
  });

  /** BFL shaped inner adapter answering with a result URL. */
  const bflInner = (): CostAwareProvider => ({
    name: "flux-api",
    kind: "image",
    supports: () => true,
    estimateCostMicros: () => 50_000,
    invoke: async <_TIn, TOut>(): Promise<ProviderResponse<TOut>> =>
      ({ output: { imageUrl: "https://bfl.example/sample.png", raw: {} }, costMicros: 50_000 }) as ProviderResponse<TOut>,
  });

  it("downloads the result with the router's abort signal", async () => {
    const png = await encodePng(solidCanvas(8, 8, 1, 2, 3));
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetchFn = async (_url: string, init?: RequestInit): Promise<Response> => {
      signals.push(init?.signal);
      return new Response(new Uint8Array(png), { status: 200 });
    };
    const registry = new ProviderRegistry();
    registry.register(new ScenePlateBridge(bflInner(), "bfl", "flux-image", fetchFn));
    const result = await callWithFailover<ScenePlateInputLike, ImageOutput>(
      registry,
      { [SCENE_PLATE_TASK]: ["flux-image"] },
      new InMemoryCostMeter(),
      new InMemoryBreakerStore(),
      { task: SCENE_PLATE_TASK, input: { prompt: "plate", width: 1000, height: 1000 } },
    );
    expect(result.output.png.equals(png)).toBe(true);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("maps a missing result to a provider error that is not retried", async () => {
    const fetchFn = async (): Promise<Response> => new Response("gone", { status: 404 });
    const bridge = new ScenePlateBridge(bflInner(), "bfl", "flux-image", fetchFn);
    const err = await bridge
      .invoke({ task: SCENE_PLATE_TASK, input: { prompt: "plate", width: 1000, height: 1000 } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(false);
    expect((err as ProviderError).message).toContain("404");
  });
});

type ScenePlateInputLike = { prompt: string; width: number; height: number };

describe("live failures keep their spend and plain copy (5.1, 5.4)", () => {
  const argsFor = (shot: Shot) => ({ shot, attempt: 1, useFallbackProvider: false, jobId: "job-f", workspaceId: "ws-1" });

  it("tells the seller the image service declined the scene and books the cutout", async () => {
    const blocked = new FakeGeminiInner("gemini-image", false, () =>
      new ProviderError("declined", "gemini-image", SCENE_PLATE_TASK, false, undefined, { code: "content_blocked" }),
    );
    const { ai, wiring } = bridgedDeps([blocked], await productCutoutPng(96));
    const generator = new LiveShotGenerator({ ai, wiring, loadMedia: async () => Buffer.from("source-photo") });
    const err = await generator.generate(argsFor(compositeShotArgs)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShotUnavailableError);
    expect((err as ShotUnavailableError).message).toBe(SHOT_CONTENT_BLOCKED);
    expect((err as ShotUnavailableError).costMicros).toBe(20_000);
  });

  it("keeps the cutout spend on a shot whose image providers are down", async () => {
    const down = new FakeGeminiInner("gemini-image", false, () =>
      new ProviderError("upstream 400", "gemini-image", SCENE_PLATE_TASK, false),
    );
    const { ai, wiring } = bridgedDeps([down], await productCutoutPng(96));
    const generator = new LiveShotGenerator({ ai, wiring, loadMedia: async () => Buffer.from("source-photo") });
    const err = await generator.generate(argsFor(compositeShotArgs)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShotFailedAfterSpendError);
    expect((err as ShotFailedAfterSpendError).costMicros).toBe(20_000);

    const outcome = await runShot(
      { ...compositeShotArgs, id: "shot-down" },
      { jobId: "job-down", workspaceId: "ws-1" },
      { ...buildRuntimeDeps(), generator: new LiveShotGenerator({ ai, wiring, loadMedia: async () => Buffer.from("source-photo") }) },
    );
    expect(outcome.status).toBe("needs_review");
    expect(outcome.verdict.repairHint).toBe(SHOT_PROVIDER_TROUBLE);
    expect(outcome.costMicros).toBe(20_000);
  });

  it("passes the spend alert hook to the cutout and scene calls (5.7)", async () => {
    const capStore = new InMemoryCapStore();
    await capStore.add("caps:global:2026-09-28", 50_000_000);
    const caps = new SpendCaps(capStore, () => new Date("2026-09-28T12:00:00Z"));
    const { ai, wiring } = bridgedDeps([new FakeGeminiInner("gemini-image", false)], await productCutoutPng(96), caps);
    const alerts: number[] = [];
    ai.onCapAlert = (total) => alerts.push(total);
    const generator = new LiveShotGenerator({ ai, wiring, loadMedia: async () => Buffer.from("source-photo") });
    await generator.generate(argsFor(compositeShotArgs));
    // Cutout, scene plate and harmonization each reserved past the line.
    expect(alerts).toHaveLength(3);
    expect(alerts.every((total) => total >= 50_000_000)).toBe(true);
  });
});

describe("source photo orientation (7.8)", () => {
  class RecordingCutout extends FakeCutoutProvider {
    readonly received: Buffer[] = [];
    override async invoke<TIn, TOut>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
      this.received.push(Buffer.from((req.input as unknown as PhotoroomCutoutInput).imageBytes));
      return super.invoke(req);
    }
  }

  it("sends the cutout service upright pixels, not an EXIF rotation tag", async () => {
    // A phone photo stored 40x20 with an orientation tag that displays it 20x40.
    const sideways = await rawToSharp(solidCanvas(40, 20, 90, 120, 150))
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect(imageDimensions(sideways)).toEqual({ width: 40, height: 20 });

    const cutout = new RecordingCutout(await productCutoutPng(96));
    const registry = new ProviderRegistry();
    registry.register(cutout);
    const ai: PipelineDeps["ai"] = {
      registry,
      routing: { [CUTOUT_TASK]: ["photoroom"] },
      meter: new InMemoryCostMeter(),
      breakerStore: new InMemoryBreakerStore(),
    };
    const generator = new LiveShotGenerator({
      ai,
      wiring: { llmLive: true, imageProviders: [], cutoutLive: true },
      loadMedia: async () => sideways,
    });
    await generator.generate({
      shot: { ...compositeShotArgs, id: "main-o", type: "amazon_main", method: "deterministic", channels: ["amazon.main"], stylePreset: "none" },
      attempt: 1,
      useFallbackProvider: false,
      jobId: "job-o",
      workspaceId: "ws-1",
    });

    expect(cutout.received).toHaveLength(1);
    const [sent] = cutout.received;
    expect(imageDimensions(sent)).toEqual({ width: 20, height: 40 });
    expect(sent.includes(Buffer.from("Exif"))).toBe(false);
  });

  it("sends bytes it cannot read as they are", async () => {
    const cutout = new RecordingCutout(await productCutoutPng(96));
    const registry = new ProviderRegistry();
    registry.register(cutout);
    const generator = new LiveShotGenerator({
      ai: { registry, routing: { [CUTOUT_TASK]: ["photoroom"] }, meter: new InMemoryCostMeter(), breakerStore: new InMemoryBreakerStore() },
      wiring: { llmLive: true, imageProviders: [], cutoutLive: true },
      loadMedia: async () => Buffer.from("heic-bytes"),
    });
    await generator.generate({
      shot: { ...compositeShotArgs, id: "main-h", type: "amazon_main", method: "deterministic", channels: ["amazon.main"], stylePreset: "none" },
      attempt: 1,
      useFallbackProvider: false,
      jobId: "job-heic",
      workspaceId: "ws-1",
    });
    expect(cutout.received[0].toString()).toBe("heic-bytes");
  });
});
