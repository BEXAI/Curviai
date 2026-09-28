/**
 * CLAUDE.md rule 3 on the live generator path: every file LiveShotGenerator
 * ships (stills, templates, composites and the other channel files derived
 * from a composite) keeps the product pixels inside the mask, proven on the
 * decoded shipped bytes. Also the thin product cases of Update.md 2.2 and the
 * lossy composite encoding of 2.3.
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
  deriveQcErodePx,
  encodeJpeg,
  encodePng,
  erode,
  fidelityReport,
  qcKindForSpec,
  solidCanvas,
  type HarmonizeInput,
  type ImageOutput,
  type RawImage,
  type RawMask,
  type Shot,
} from "@curvi/pipeline";
import { CUTOUT_TASK, HARMONIZE_TASK, SCENE_PLATE_TASK } from "@curvi/pipeline/seed";
import { getSpec } from "@curvi/specs";
import { alphaMask, LiveShotGenerator, upscaleErodePx } from "./live-runtime";
import { InMemoryJobStore, runShot, systemClock, type PipelineDeps, type ShotGeneration } from "./pipeline-runner";
import { DemoLlmProvider, demoRoutingTable } from "./runtime";
import { maskArea } from "./shot-outputs";

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

/**
 * Scene provider that repaints everything it touches: plates are a flat warm
 * color, and harmonization returns a flat red canvas of the draft's size, so
 * any product pixel not pasted back would show up as red.
 */
class CorruptingSceneProvider implements Provider {
  readonly name = "gemini-image";
  readonly kind = "image" as const;
  calls = 0;
  supports(task: string): boolean {
    return task === SCENE_PLATE_TASK || task === HARMONIZE_TASK;
  }
  estimateCostMicros(): number {
    return 67_000;
  }
  async invoke<TIn, TOut>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    this.calls += 1;
    if (req.task === HARMONIZE_TASK) {
      const draft = await decodeToRgba((req.input as unknown as HarmonizeInput).png);
      const red = await encodePng(solidCanvas(draft.width, draft.height, 200, 30, 30));
      return { output: { png: red } as ImageOutput as TOut, costMicros: 67_000 };
    }
    const plate = await encodePng(solidCanvas(64, 64, 245, 238, 226));
    return { output: { png: plate } as ImageOutput as TOut, costMicros: 67_000 };
  }
}

function setup(cutoutPng: Buffer): {
  generator: LiveShotGenerator;
  deps: PipelineDeps;
  scene: CorruptingSceneProvider;
  cutout: FakeCutoutProvider;
} {
  const registry = new ProviderRegistry();
  const scene = new CorruptingSceneProvider();
  const cutout = new FakeCutoutProvider(cutoutPng);
  registry.register(new DemoLlmProvider());
  registry.register(scene);
  registry.register(cutout);
  const routing = {
    ...demoRoutingTable(),
    [SCENE_PLATE_TASK]: ["gemini-image"],
    [HARMONIZE_TASK]: ["gemini-image"],
    [CUTOUT_TASK]: ["photoroom"],
  };
  const ai: PipelineDeps["ai"] = {
    registry,
    routing,
    meter: new InMemoryCostMeter(),
    breakerStore: new InMemoryBreakerStore(),
  };
  const generator = new LiveShotGenerator({
    ai,
    wiring: { llmLive: false, imageProviders: ["gemini-image"], cutoutLive: true },
    loadMedia: async () => Buffer.from("source-photo"),
  });
  return { generator, deps: { ai, store: new InMemoryJobStore(), clock: systemClock, generator }, scene, cutout };
}

/** Textured product: gradients and seeded noise inside an ellipse. */
async function texturedCutout(width: number, height: number, noise = 14): Promise<Buffer> {
  const image = solidCanvas(width, height, 0, 0, 0, 0);
  let seed = 4242;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % (2 * noise + 1)) - noise;
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

/** A thin opaque bar on a transparent canvas, like a chain or a cable. */
async function barCutout(
  width: number,
  height: number,
  bar: { width: number; height: number },
  rgb: [number, number, number] = [150, 40, 80],
): Promise<Buffer> {
  const image = solidCanvas(width, height, 0, 0, 0, 0);
  const left = Math.floor((width - bar.width) / 2);
  const top = Math.floor((height - bar.height) / 2);
  for (let y = top; y < top + bar.height; y++) {
    for (let x = left; x < left + bar.width; x++) {
      const o = (y * width + x) * 4;
      image.data[o] = rgb[0];
      image.data[o + 1] = rgb[1];
      image.data[o + 2] = rgb[2];
      image.data[o + 3] = 255;
    }
  }
  return encodePng(image);
}

function shotOf(type: Shot["type"], method: Shot["method"], channels: string[], extra: Partial<Shot> = {}): Shot {
  return {
    id: `${type}-${channels.join("+")}`,
    type,
    sourceMediaId: "ws/ws-1/src/photo",
    method,
    channels,
    stylePreset: "kitchen_lifestyle",
    credits: 1,
    priority: 1,
    ...extra,
  };
}

const argsFor = (shot: Shot, attempt = 1) => ({
  shot,
  attempt,
  useFallbackProvider: false,
  jobId: "job-rule3",
  workspaceId: "ws-1",
  brandColors: ["#1A7F3C"],
});

function tintInsideMask(image: RawImage, mask: RawMask, amount: number): RawImage {
  const data = Buffer.from(image.data);
  for (let i = 0; i < mask.data.length; i++) {
    if (mask.data[i] === 0) continue;
    data[i * 4] = Math.min(255, data[i * 4] + amount);
  }
  return { ...image, data };
}

/**
 * The rule 3 invariant for one shipped file: decoded bytes equal the image
 * the runner checks, the product reference matches inside the eroded mask
 * (byte for byte when the file is lossless), and a tint inside the product
 * fails the same check.
 */
async function expectProductKept(generation: ShotGeneration, specId: string): Promise<void> {
  const spec = getSpec(specId);
  if (spec.width) expect(generation.image.width).toBe(spec.width);
  if (spec.height) expect(generation.image.height).toBe(spec.height);
  const shipped = await decodeToRgba(generation.encoded.buffer);
  expect(shipped.data.equals(generation.image.data)).toBe(true);
  if (!generation.mask || !generation.productReference) {
    throw new Error("a live output must carry its mask and product reference");
  }
  const opts = { kind: qcKindForSpec(spec), erodePx: generation.fidelityErodePx };
  const report = await fidelityReport(generation.productReference, shipped, generation.mask, opts);
  expect(report.issues, specId).toEqual([]);
  expect(report.maskArea).toBeGreaterThan(0);
  if (generation.encoded.format === "png") {
    expect(report.exactByteShare, specId).toBe(1);
  }
  const tinted = await fidelityReport(
    generation.productReference,
    tintInsideMask(shipped, generation.mask, 30),
    generation.mask,
    opts,
  );
  expect(tinted.pass).toBe(false);
}

describe("rule 3 on every live output", () => {
  const cases: Array<{ shot: Shot }> = [
    { shot: shotOf("amazon_main", "deterministic", ["amazon.main"], { stylePreset: "none" }) },
    { shot: shotOf("alt_angle_white", "deterministic", ["amazon.secondary"], { stylePreset: "none" }) },
    { shot: shotOf("alt_angle_white", "deterministic", ["google.merchant.lifestyle"], { stylePreset: "none" }) },
    { shot: shotOf("alt_angle_white", "deterministic", ["google.merchant.main"], { stylePreset: "none" }) },
    { shot: shotOf("cutout_png", "deterministic", ["shopify.product"], { stylePreset: "none" }) },
    { shot: shotOf("sweep_gray", "deterministic", ["amazon.secondary"]) },
    { shot: shotOf("sweep_brand", "deterministic", ["shopify.product"]) },
    { shot: shotOf("collection_thumb", "deterministic", ["shopify.product"], { stylePreset: "none" }) },
    {
      shot: shotOf("infographic", "template", ["amazon.secondary"], {
        stylePreset: "none",
        callouts: ["Keeps drinks hot", "Dishwasher safe", "Fits cup holders"],
      }),
    },
    { shot: shotOf("social_1x1", "template", ["meta.feed_1x1"]) },
    { shot: shotOf("lifestyle", "composite_generate", ["meta.feed_1x1"], { scene: "kitchen counter" }) },
    { shot: shotOf("shopify_hero", "composite_generate", ["shopify.hero_banner"]) },
    // Marketplace listing slots the runner now keeps and packs (Update.md 2.11).
    { shot: shotOf("alt_angle_white", "deterministic", ["etsy.listing"], { stylePreset: "none" }) },
    { shot: shotOf("alt_angle_white", "deterministic", ["ebay.listing"], { stylePreset: "none" }) },
    { shot: shotOf("alt_angle_white", "deterministic", ["walmart.main"], { stylePreset: "none" }) },
    { shot: shotOf("alt_angle_white", "deterministic", ["tiktokshop.main"], { stylePreset: "none" }) },
    { shot: shotOf("social_9x16", "template", ["pinterest.pin"]) },
  ];

  for (const { shot } of cases) {
    it(`${shot.type} on ${shot.channels[0]} keeps the product pixels`, async () => {
      const { generator } = setup(await texturedCutout(480, 360));
      const generation = await generator.generate(argsFor(shot));
      await expectProductKept(generation, shot.channels[0]);
    });
  }

  it("the composite pastes the product back over a harmonization that repainted it", async () => {
    const { generator, scene } = setup(await texturedCutout(480, 360));
    const generation = await generator.generate(
      argsFor(shotOf("lifestyle", "composite_generate", ["amazon.secondary"], { scene: "desk" })),
    );
    expect(scene.calls).toBe(2);
    // The repaint shows everywhere outside the product...
    expect([...generation.image.data.subarray(0, 3)]).toEqual([200, 30, 30]);
    // ...and nowhere inside it.
    await expectProductKept(generation, "amazon.secondary");
  });

  it("derives every other channel of a composite without a provider call, keeping the product", async () => {
    const { generator, scene } = setup(await texturedCutout(480, 360));
    const shot = shotOf("lifestyle", "composite_generate", ["shopify.product"], { scene: "desk" });
    const primary = await generator.generate(argsFor(shot));
    await expectProductKept(primary, "shopify.product");
    const callsAfterPrimary = scene.calls;

    for (const specId of ["amazon.secondary", "google.merchant.lifestyle", "meta.feed_4x5"]) {
      const derived = await generator.deriveForSpec(argsFor(shot), primary, specId);
      expect(derived.costMicros).toBe(0);
      await expectProductKept(derived, specId);
    }
    expect(scene.calls).toBe(callsAfterPrimary);
  });

  it("delivers a multi channel composite through the runner with one scene and a file per channel", async () => {
    const { deps, scene } = setup(await texturedCutout(480, 360));
    const shot = shotOf("lifestyle", "composite_generate", ["amazon.secondary", "shopify.product", "google.merchant.lifestyle"], {
      scene: "desk",
    });
    const outcome = await runShot(shot, { jobId: "job-rule3", workspaceId: "ws-1", sku: "SKU", seoSlug: "mug" }, deps);
    expect(outcome.status).toBe("passed");
    expect(outcome.outputs.map((o) => [o.specId, o.status])).toEqual([
      ["shopify.product", "passed"],
      ["amazon.secondary", "passed"],
      ["google.merchant.lifestyle", "passed"],
    ]);
    expect(outcome.packAssets?.map((a) => a.specId).sort()).toEqual(
      ["amazon.secondary", "google.merchant.lifestyle", "shopify.product"],
    );
    expect(scene.calls).toBe(2);
  });
});

describe("thin products (2.2)", () => {
  it("passes a thin bar composite on the first attempt", async () => {
    const { generator, deps, scene } = setup(await barCutout(480, 480, { width: 400, height: 4 }));
    const shot = shotOf("lifestyle", "composite_generate", ["meta.feed_1x1"], { scene: "jewelry tray" });

    const generation = await generator.generate(argsFor(shot));
    if (!generation.mask || !generation.productReference) throw new Error("expected mask and reference");
    // The package default erosion leaves nothing to compare on this bar.
    const atDefault = await fidelityReport(generation.productReference, generation.image, generation.mask, {
      erodePx: deriveQcErodePx(),
    });
    expect(atDefault.issues).toContain("eroded_mask_empty");
    await expectProductKept(generation, "meta.feed_1x1");

    scene.calls = 0;
    const outcome = await runShot(shot, { jobId: "job-thin", workspaceId: "ws-1" }, deps);
    expect(outcome.status).toBe("passed");
    expect(outcome.attempts).toBe(1);
    expect(outcome.fidelityPass).toBe(true);
    expect(scene.calls).toBe(2);
  });

  it("passes an upscaled thin still", async () => {
    const cutoutPng = await barCutout(240, 180, { width: 60, height: 6 });
    const { generator, deps } = setup(cutoutPng);
    const shot = shotOf("amazon_main", "deterministic", ["amazon.main"], { stylePreset: "none" });

    const generation = await generator.generate(argsFor(shot));
    if (!generation.mask) throw new Error("expected a mask");
    // The upscale erosion alone would erase this bar.
    const cutoutMask = alphaMask(await decodeToRgba(cutoutPng));
    const upscale = upscaleErodePx(cutoutMask, generation.mask);
    expect(upscale).toBeDefined();
    expect(maskArea(await erode(generation.mask, upscale as number))).toBe(0);
    await expectProductKept(generation, "amazon.main");

    const outcome = await runShot(shot, { jobId: "job-thin-still", workspaceId: "ws-1" }, deps);
    expect(outcome.status).toBe("passed");
    expect(outcome.fidelityPass).toBe(true);
  }, 120_000);
});

describe("lossy composites are checked as shipped (2.3)", () => {
  it("encodes a JPEG only channel at a quality whose decoded product still passes", async () => {
    const { generator } = setup(await texturedCutout(480, 360, 60));
    const shot = shotOf("shopify_hero", "composite_generate", ["shopify.hero_banner"]);
    const generation = await generator.generate(argsFor(shot));
    expect(generation.encoded.format).toBe("jpg");
    await expectProductKept(generation, "shopify.hero_banner");

    // The first rung would not have kept the product, so the ladder climbed.
    if (!generation.canvas || !generation.mask || !generation.productReference) throw new Error("expected canvas");
    const q90 = await decodeToRgba(await encodeJpeg(generation.canvas, 90));
    const atQ90 = await fidelityReport(generation.productReference, q90, generation.mask, {
      kind: "other",
      erodePx: generation.fidelityErodePx,
    });
    expect(atQ90.pass).toBe(false);
  });
});
