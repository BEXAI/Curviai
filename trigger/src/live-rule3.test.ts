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
  dilate,
  encodeJpeg,
  encodePng,
  erode,
  fidelityReport,
  makeOriginalFit,
  planShots,
  qcKindForSpec,
  rawToSharp,
  solidCanvas,
  type HarmonizeInput,
  type ImageOutput,
  type RawImage,
  type RawMask,
  type Shot,
} from "@curvi/pipeline";
import {
  hexToRgb,
  normalizeOutputOptions,
  planFlagsOf,
  resolveColorHex,
  resolveOutputOptions,
  SOURCE_TOO_SMALL_REASON,
  type OutputOptionsInput,
  type ResolvedOutputOptions,
} from "@curvi/pipeline/output-options";
import { backgroundSwatches, CUTOUT_TASK, HARMONIZE_TASK, SCENE_PLATE_TASK } from "@curvi/pipeline/seed";
import { getSpec, listSpecs } from "@curvi/specs";
import { renderDeterministicShot, renderOnBackground } from "./live-deterministic";
import { ORIGINAL_DRIFTED, renderOriginalShot } from "./live-original";
import type { LiveProduct } from "./live-product";
import { alphaMask, LiveShotGenerator, upscaleErodePx } from "./live-runtime";
import { InMemoryJobStore, runShot, systemClock, type PipelineDeps, type ShotGeneration } from "./pipeline-runner";
import { DemoLlmProvider, demoProfile, demoRoutingTable } from "./runtime";
import { encodeMaskPng, maskArea, QC_EDGE_MARGIN_PX } from "./shot-outputs";

class FakeCutoutProvider implements Provider {
  readonly name = "fal-birefnet";
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
    [CUTOUT_TASK]: ["fal-birefnet"],
  };
  const ai: PipelineDeps["ai"] = {
    registry,
    routing,
    meter: new InMemoryCostMeter(),
    breakerStore: new InMemoryBreakerStore(),
  };
  const generator = new LiveShotGenerator({
    ai,
    wiring: { llmLive: false, imageProviders: ["gemini-image"], cutoutProviders: ["fal-birefnet"], cutoutLive: true },
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

describe("kept photos and colored backgrounds keep the product pixels (PHASE_15)", () => {
  const photoKey = "ws/ws-1/src/kept.jpg";
  const photoSize = { width: 2400, height: 1800 };
  const white = resolveColorHex({ kind: "swatch", key: "white" }, []) as string;
  const optionsWith = (input: OutputOptionsInput, colorHex: string): ResolvedOutputOptions =>
    resolveOutputOptions(normalizeOutputOptions(input), {
      colorHex,
      brandSweepHex: white,
      keepMediaIds: input.background === "keep" ? [photoKey] : [],
    });

  let photoBytes: Promise<Buffer> | null = null;
  /** A textured 2400 x 1800 JPEG, like a phone photo on a table. */
  function keptPhoto(): Promise<Buffer> {
    photoBytes ??= (async () => {
      const { width, height } = photoSize;
      const image = solidCanvas(width, height, 0, 0, 0);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const o = (y * width + x) * 4;
          image.data[o] = 50 + Math.round((150 * x) / width) + ((x * 7 + y * 3) % 11);
          image.data[o + 1] = 70 + Math.round((120 * y) / height) + ((x * 5 + y * 13) % 9);
          image.data[o + 2] = 140 + ((x + y) % 60);
        }
      }
      return encodeJpeg(image, 92);
    })();
    return photoBytes;
  }

  /** Every spec the front kept photo may ship on, as the planner routes it. */
  function keptSpecIds(): string[] {
    const output = optionsWith({ background: "keep" }, white);
    const plan = planShots(demoProfile, {
      channels: listSpecs().map((spec) => spec.id),
      tier: "agency",
      creditBudget: 1000,
      primaryMediaId: photoKey,
      output: planFlagsOf(output, [{ id: photoKey, ...photoSize }]),
    });
    const original = plan.shots.find((shot) => shot.type === "original_photo" && shot.sourceMediaId === photoKey);
    return original?.channels ?? [];
  }

  const originalShot = (specId: string): Shot => ({
    id: `original-${specId}`,
    type: "original_photo",
    sourceMediaId: photoKey,
    method: "deterministic",
    channels: [specId],
    stylePreset: "none",
    credits: 0.5,
    priority: 1,
  });

  for (const fit of ["auto", "pad", "crop"] as const) {
    it(`original_photo passes fidelity with kind main on every spec it may target, fit ${fit}`, async () => {
      const photo = await keptPhoto();
      // The crop run also matches the photo's edges where a crop falls back to pad.
      const output =
        fit === "crop"
          ? optionsWith({ background: "keep", fit, color: { kind: "edge_match" } }, white)
          : optionsWith({ background: "keep", fit, color: { kind: "swatch", key: "sand" } }, "#EADFCF");
      const generator = new LiveShotGenerator({
        ai: { registry: new ProviderRegistry(), routing: {}, meter: new InMemoryCostMeter(), breakerStore: new InMemoryBreakerStore() },
        wiring: { llmLive: false, imageProviders: [], cutoutProviders: [], cutoutLive: false },
        loadMedia: async (key) => (key === photoKey ? photo : null),
      });
      const specIds = keptSpecIds();
      expect(specIds.length).toBeGreaterThan(3);
      let cropped = 0;
      for (const specId of specIds) {
        const generation = await generator.generate({
          shot: originalShot(specId),
          attempt: 1,
          useFallbackProvider: false,
          jobId: "job-kept",
          workspaceId: "ws-1",
          output,
          ...(fit === "crop" ? { productBox: { x: 0.35, y: 0.3, width: 0.3, height: 0.4 } } : {}),
        });
        expect(generation.fidelityKind, specId).toBe("main");
        if (fit === "crop") {
          expect(generation.treatment?.cropped || generation.treatment?.cropFallback, specId).toBe(true);
          if (generation.treatment?.cropped) cropped++;
        }
        if (generation.passthrough) {
          expect(generation.encoded.buffer.equals(photo), specId).toBe(true);
          continue;
        }
        if (!generation.mask || !generation.productReference) {
          throw new Error(`a rendered kept photo on ${specId} must carry its mask and reference`);
        }
        const shipped = await decodeToRgba(generation.encoded.buffer);
        const report = await fidelityReport(generation.productReference, shipped, generation.mask, {
          kind: "main",
          erodePx: generation.fidelityErodePx,
        });
        expect(report.issues, specId).toEqual([]);
        expect(report.maskArea, specId).toBeGreaterThan(0);
      }
      if (fit === "crop") {
        expect(cropped).toBeGreaterThan(0);
      }
    }, 120_000);
  }

  it("never enlarges a kept photo with Never enlarge my photo", async () => {
    const small = await encodeJpeg(solidCanvas(1200, 1200, 90, 120, 150), 92);
    const spec = getSpec("amazon.secondary");
    // 1200 px reaches amazon.secondary's 1600 minimum only by enlarging it.
    const enlarged = await renderOriginalShot({
      shot: originalShot(spec.id),
      spec,
      workspaceId: "ws-1",
      output: optionsWith({ background: "keep" }, white),
      loadSource: async () => small,
    });
    expect(enlarged.kind === "rendered" ? enlarged.still.treatment.scale : 1).toBeGreaterThan(1);
    await expect(
      renderOriginalShot({
        shot: originalShot(spec.id),
        spec,
        workspaceId: "ws-1",
        output: optionsWith({ background: "keep", enlarge: false }, white),
        loadSource: async () => small,
      }),
    ).rejects.toThrow(SOURCE_TOO_SMALL_REASON);
  });

  it("fails a render that sharpens, brightens or shifts the photo by one pixel", async () => {
    const photo = await keptPhoto();
    const spec = getSpec("amazon.secondary");
    const mutate =
      (change: (raw: RawImage) => Promise<RawImage>): typeof makeOriginalFit =>
      async (bytes, s, opts) => {
        const fitted = await makeOriginalFit(bytes, s, opts);
        return fitted.raw ? { ...fitted, raw: await change(fitted.raw) } : fitted;
      };
    const viaSharp = (edit: (img: ReturnType<typeof rawToSharp>) => ReturnType<typeof rawToSharp>) => async (raw: RawImage) => {
      const data = await edit(rawToSharp(raw)).ensureAlpha().raw().toBuffer();
      return { ...raw, data };
    };
    const shiftRight = async (raw: RawImage): Promise<RawImage> => {
      const data = Buffer.from(raw.data);
      for (let y = 0; y < raw.height; y++) {
        const row = y * raw.width * 4;
        raw.data.copy(data, row + 4, row, row + (raw.width - 1) * 4);
      }
      return { ...raw, data };
    };
    const doubles = {
      sharpen: mutate(viaSharp((img) => img.sharpen())),
      brighten: mutate(viaSharp((img) => img.modulate({ brightness: 1.02 }))),
      shift: mutate(shiftRight),
    };
    const honest = await renderOriginalShot({
      shot: originalShot(spec.id),
      spec,
      workspaceId: "ws-1",
      loadSource: async () => photo,
    });
    expect(honest.kind).toBe("rendered");
    for (const [name, fitOriginal] of Object.entries(doubles)) {
      await expect(
        renderOriginalShot({ shot: originalShot(spec.id), spec, workspaceId: "ws-1", loadSource: async () => photo, fitOriginal }),
        name,
      ).rejects.toThrow(ORIGINAL_DRIFTED);
    }
  }, 60_000);

  /** The textured cutout as the live generator hands it to the renderers. */
  async function liveProduct(): Promise<LiveProduct> {
    const productPng = await texturedCutout(480, 360);
    const productRgba = await decodeToRgba(productPng);
    const mask = alphaMask(productRgba);
    return { productRgba, mask, productPng, maskPng: await encodeMaskPng(mask) };
  }

  it("renderOnBackground on #1F2A44 keeps the product pixels of the white render inside the eroded mask", async () => {
    const product = await liveProduct();
    const spec = getSpec("amazon.secondary");
    const onWhite = await renderOnBackground(product, spec, { rgb: hexToRgb(white) });
    const onNavy = await renderOnBackground(product, spec, { rgb: hexToRgb("#1F2A44") });
    expect(onNavy.productReference.data.equals(onWhite.productReference.data)).toBe(true);
    const erodePx = Math.max(onWhite.fidelityErosion?.erodePx ?? 0, onNavy.fidelityErosion?.erodePx ?? 0);
    const mask = onWhite.mask as RawMask;
    for (const render of [onWhite, onNavy]) {
      const own = await fidelityReport(render.productReference, await decodeToRgba(render.encoded.buffer), mask, {
        kind: "main",
        erodePx,
      });
      expect(own.issues).toEqual([]);
    }
    const whitePixels = await decodeToRgba(onWhite.encoded.buffer);
    const navyPixels = await decodeToRgba(onNavy.encoded.buffer);
    const same = await fidelityReport(whitePixels, navyPixels, mask, { kind: "main", erodePx });
    expect(same.issues).toEqual([]);
    // The navy file really is navy outside the product.
    expect(navyPixels.data[0]).toBeLessThan(80);
  });

  it("keeps amazon_main exactly 255 white under every color the seller can pick", async () => {
    const product = await liveProduct();
    const spec = getSpec("amazon.main");
    const colors = [...Object.values(backgroundSwatches).map((swatch) => swatch.hex), "#1F2A44"];
    for (const hex of colors) {
      const output = optionsWith({ color: { kind: "custom", hex } }, hex);
      const render = await renderDeterministicShot({
        shot: shotOf("amazon_main", "deterministic", ["amazon.main"], { stylePreset: "none" }),
        product,
        output,
      });
      const shipped = await decodeToRgba(render.encoded.buffer);
      const outside = await dilate(render.mask as RawMask, QC_EDGE_MARGIN_PX);
      let offWhite = 0;
      for (let i = 0; i < outside.data.length; i++) {
        if (outside.data[i] !== 0) continue;
        const o = i * 4;
        if (shipped.data[o] !== 255 || shipped.data[o + 1] !== 255 || shipped.data[o + 2] !== 255) offWhite += 1;
      }
      expect(offWhite, hex).toBe(0);
      expect(spec.background?.type).toBe("solid");
      expect(render.treatment?.colorHex, hex).toBe(white);
    }
  });
});
