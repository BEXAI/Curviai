/**
 * PHASE_16 workstream 3 on the live generator path: the moodboard pin, the
 * static ad variants and the carousel slides keep every product pixel real
 * (rule 3, proven on the decoded shipped bytes), and a carousel's scene
 * layer is made once, by its first slide, and reused by the others, in
 * this process or another one (founder decision 4).
 */
import { describe, expect, it } from "vitest";
import {
  InMemoryBreakerStore,
  InMemoryCostMeter,
  ProviderRegistry,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
} from "@curvi/ai";
import {
  decodeToRgba,
  encodePng,
  fidelityReport,
  qcKindForSpec,
  solidCanvas,
  type HarmonizeInput,
  type ImageOutput,
  type Shot,
} from "@curvi/pipeline";
import { adsFormats, CUTOUT_TASK, HARMONIZE_TASK, SCENE_PLATE_TASK } from "@curvi/pipeline/seed";
import { getSpec } from "@curvi/specs";
import type { CachedCutout, CutoutCacheStore } from "./cutout-cache";
import { ShotUnavailableError } from "./errors";
import {
  CAROUSEL_SCENE_NOT_READY,
  carouselPlateKey,
  carouselSlideContentOf,
  LiveShotGenerator,
} from "./live-runtime";
import type { PipelineDeps, ShotGeneration } from "./pipeline-runner";
import { DemoLlmProvider, demoRoutingTable } from "./runtime";

class FakeCutoutProvider implements Provider {
  readonly name = "fal-birefnet";
  readonly kind = "cutout" as const;
  constructor(private readonly png: Buffer) {}
  supports(task: string): boolean {
    return task === CUTOUT_TASK;
  }
  estimateCostMicros(): number {
    return 20_000;
  }
  async invoke<TIn, TOut>(_req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    return { output: { imageBytes: this.png, contentType: "image/png" } as TOut, costMicros: 20_000 };
  }
}

/** Plates are a warm gradient; harmonization repaints everything red, so a
 * product pixel not pasted back would show. */
class SceneProvider implements Provider {
  readonly name = "gemini-image";
  readonly kind = "image" as const;
  plates = 0;
  supports(task: string): boolean {
    return task === SCENE_PLATE_TASK || task === HARMONIZE_TASK;
  }
  estimateCostMicros(): number {
    return 67_000;
  }
  async invoke<TIn, TOut>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    if (req.task === HARMONIZE_TASK) {
      const draft = await decodeToRgba((req.input as unknown as HarmonizeInput).png);
      const red = await encodePng(solidCanvas(draft.width, draft.height, 200, 30, 30));
      return { output: { png: red } as ImageOutput as TOut, costMicros: 67_000 };
    }
    this.plates += 1;
    const plate = solidCanvas(96, 48, 0, 0, 0);
    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 96; x++) {
        const o = (y * 96 + x) * 4;
        plate.data[o] = 200 + Math.round(x / 3);
        plate.data[o + 1] = 180 + Math.round(y / 2);
        plate.data[o + 2] = 150;
      }
    }
    return { output: { png: await encodePng(plate) } as ImageOutput as TOut, costMicros: 67_000 };
  }
}

class MemoryStore implements CutoutCacheStore {
  readonly entries = new Map<string, CachedCutout>();
  async get(key: string): Promise<CachedCutout | null> {
    return this.entries.get(key) ?? null;
  }
  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    this.entries.set(key, { bytes, contentType, storedAt: new Date() });
  }
}

async function texturedCutout(width = 400, height = 520): Promise<Buffer> {
  const image = solidCanvas(width, height, 0, 0, 0, 0);
  let seed = 99;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 29) - 14;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x + 0.5 - width / 2) / (width * 0.32);
      const dy = (y + 0.5 - height / 2) / (height * 0.38);
      if (dx * dx + dy * dy > 1) continue;
      const o = (y * width + x) * 4;
      image.data[o] = Math.max(0, Math.min(255, Math.round(60 + (120 * x) / width + rand())));
      image.data[o + 1] = Math.max(0, Math.min(255, Math.round(50 + (130 * y) / height + rand())));
      image.data[o + 2] = Math.max(0, Math.min(255, Math.round(170 - (60 * x) / width + rand())));
      image.data[o + 3] = 255;
    }
  }
  return encodePng(image);
}

function setup(cutoutPng: Buffer, store: CutoutCacheStore | null) {
  const registry = new ProviderRegistry();
  const scene = new SceneProvider();
  registry.register(new DemoLlmProvider());
  registry.register(scene);
  registry.register(new FakeCutoutProvider(cutoutPng));
  const ai: PipelineDeps["ai"] = {
    registry,
    routing: {
      ...demoRoutingTable(),
      [SCENE_PLATE_TASK]: ["gemini-image"],
      [HARMONIZE_TASK]: ["gemini-image"],
      [CUTOUT_TASK]: ["fal-birefnet"],
    },
    meter: new InMemoryCostMeter(),
    breakerStore: new InMemoryBreakerStore(),
  };
  const generator = new LiveShotGenerator({
    ai,
    wiring: { llmLive: false, imageProviders: ["gemini-image"], cutoutProviders: ["fal-birefnet"], cutoutLive: true },
    loadMedia: async () => Buffer.from("source-photo"),
    ...(store ? { cutoutCache: store } : {}),
  });
  return { generator, scene };
}

const argsFor = (shot: Shot, attempt = 1) => ({
  shot,
  attempt,
  useFallbackProvider: false,
  jobId: "job-ads",
  workspaceId: "ws-1",
  brandColors: [],
});

function shotOf(type: Shot["type"], method: Shot["method"], channels: string[], extra: Partial<Shot> = {}): Shot {
  return {
    id: `${type}-${channels.join("+")}-${extra.slideIndex ?? extra.variantKey ?? 0}`,
    type,
    sourceMediaId: "ws/ws-1/src/photo",
    method,
    channels,
    stylePreset: "kitchen_lifestyle",
    credits: 0.5,
    priority: 7,
    ...extra,
  };
}

function slide(index: number, count: number, method: Shot["method"]): Shot {
  return shotOf("carousel_slide", method, [adsFormats.carousel.specId], {
    carouselId: "c1",
    slideIndex: index,
    slideCount: count,
    ...(index === count ? { headline: "Ceramic mug", cta: "Shop now" } : { headline: `Line ${index}` }),
  });
}

async function expectProductKept(generation: ShotGeneration, specId: string): Promise<void> {
  const spec = getSpec(specId);
  expect(generation.image.width).toBe(spec.width);
  expect(generation.image.height).toBe(spec.height);
  const shipped = await decodeToRgba(generation.encoded.buffer);
  expect(shipped.data.equals(generation.image.data)).toBe(true);
  const opts = { kind: qcKindForSpec(spec), erodePx: generation.fidelityErodePx };
  const report = await fidelityReport(generation.productReference!, shipped, generation.mask!, opts);
  expect(report.issues, specId).toEqual([]);
  expect(report.maskArea).toBeGreaterThan(0);
}

describe("rule 3 on every live ads output", () => {
  it("keeps the product exact on the pin, every ad placement and every carousel slide", async () => {
    const { generator } = setup(await texturedCutout(), new MemoryStore());
    const cases: Shot[] = [
      shotOf("pin_moodboard", "template", ["pinterest.pin"], { headline: "Ceramic mug" }),
      shotOf("pin_moodboard", "composite_generate", ["pinterest.pin"], { headline: "Ceramic mug", scene: "kitchen" }),
      ...adsFormats.adPack.placements.map((specId) =>
        shotOf("ad_variant", "template", [specId], { variantKey: "v1", headline: "Keeps coffee hot", cta: "Shop now" }),
      ),
      slide(1, 3, "template"),
      slide(2, 3, "template"),
      slide(3, 3, "template"),
      slide(1, 3, "composite_generate"),
      slide(2, 3, "composite_generate"),
      slide(3, 3, "composite_generate"),
    ];
    for (const shot of cases) {
      const generation = await generator.generate(argsFor(shot));
      await expectProductKept(generation, shot.channels[0]!);
    }
  }, 120_000);
});

describe("the carousel scene layer (founder decision 4)", () => {
  it("is made once by the first slide and reused by the others, in this process and another", async () => {
    const store = new MemoryStore();
    const cutout = await texturedCutout();
    const first = setup(cutout, store);
    await first.generator.generate(argsFor(slide(1, 4, "composite_generate")));
    expect(first.scene.plates).toBe(1);
    expect(store.entries.has(carouselPlateKey("ws-1", "job-ads", "c1"))).toBe(true);
    await first.generator.generate(argsFor(slide(2, 4, "composite_generate")));
    expect(first.scene.plates).toBe(1);
    // Another subtask: a new generator reads the stored layer.
    const other = setup(cutout, store);
    await other.generator.generate(argsFor(slide(3, 4, "composite_generate")));
    await other.generator.generate(argsFor(slide(4, 4, "composite_generate")));
    expect(other.scene.plates).toBe(0);
    // A retried first slide makes a new layer.
    await first.generator.generate(argsFor(slide(1, 4, "composite_generate"), 2));
    expect(first.scene.plates).toBe(2);
  });

  it("never lets a later slide make a layer: without one it needs review", async () => {
    const { generator, scene } = setup(await texturedCutout(), new MemoryStore());
    const failure = await generator.generate(argsFor(slide(2, 3, "composite_generate"))).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ShotUnavailableError);
    expect((failure as Error).message).toBe(CAROUSEL_SCENE_NOT_READY);
    expect(scene.plates).toBe(0);
  });

  it("keys the layer under the workspace and the job, with nothing unsafe in the path", () => {
    expect(carouselPlateKey("ws-1", "job/../x", "c/1")).toBe("ws/ws-1/cache/carousel/jobx/c1.png");
    expect(carouselPlateKey("ws-1", "job-ads", "c1")).toBe("ws/ws-1/cache/carousel/job-ads/c1.png");
  });

  it("reads each slide's words and role from its shot", () => {
    expect(carouselSlideContentOf(slide(1, 3, "template"))).toMatchObject({ slideIndex: 1, role: "hero" });
    expect(carouselSlideContentOf(slide(2, 3, "template"))).toMatchObject({ slideIndex: 2, role: "support" });
    expect(carouselSlideContentOf(slide(3, 3, "template"))).toMatchObject({ role: "hero", cta: "Shop now" });
  });
});
