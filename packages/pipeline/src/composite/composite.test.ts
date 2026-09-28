import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  InMemoryBreakerStore,
  InMemoryCapStore,
  InMemoryCostMeter,
  ProviderError,
  ProviderRegistry,
  SpendCaps,
  callWithFailover,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
} from "@curvi/ai";
import { erode } from "../mask";
import { deriveQcErodePx, fidelityReport } from "../qc/fidelity";
import { decodeToRgba, type RawImage, type RawMask } from "../raw";
import { paintRect, rawCanvas, rectMask } from "../testutil";
import type { QCVerdict, Shot } from "../schemas";
import {
  HARMONIZE_ASPECT_TOLERANCE,
  HarmonizeAspectError,
  PASTE_ERODE_PX,
  aspectDrift,
  compositeShot,
  identityColorTransform,
  planRetry,
  withHarmonizeAspectGuard,
  type HarmonizeInput,
  type ScenePlateInput,
} from "./index";

/**
 * Mock image provider. The harmonize step DELIBERATELY corrupts the product
 * region, which the paste back step must fully undo: this is the enforcement
 * test for CLAUDE.md rule 3.
 */
class CorruptingMockProvider implements Provider {
  readonly name = "mock-corruptor";
  readonly kind = "image" as const;
  harmonizeCalls = 0;

  supports(task: string): boolean {
    return task === "scene_plate" || task === "harmonize";
  }

  async invoke<TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    if (req.task === "scene_plate") {
      const { width, height } = req.input as ScenePlateInput;
      const plate = rawCanvas(width, height, 90, 110, 130);
      const png = await sharp(plate.data, { raw: { width, height, channels: 4 } }).png().toBuffer();
      return { output: { png } as TOut, costMicros: 1200 };
    }
    if (req.task === "harmonize") {
      this.harmonizeCalls++;
      const { png } = req.input as HarmonizeInput;
      const raw = await decodeToRgba(png);
      // Repaint EVERYTHING neon green, product included.
      paintRect(raw, { left: 0, top: 0, width: raw.width, height: raw.height }, 20, 255, 20);
      const out = await sharp(raw.data, {
        raw: { width: raw.width, height: raw.height, channels: 4 },
      })
        .png()
        .toBuffer();
      return { output: { png: out } as TOut, costMicros: 800 };
    }
    throw new Error(`Unsupported task ${req.task}`);
  }
}

const shot: Shot = {
  id: "s01_lifestyle",
  type: "lifestyle",
  sourceMediaId: "source_1",
  method: "composite_generate",
  channels: ["shopify.product"],
  stylePreset: "minimal_studio",
  scene: "kitchen counter",
  credits: 1,
  priority: 4,
};

describe("compositeShot", () => {
  it("restores the exact product bytes after a corrupting harmonize pass", async () => {
    const product = rawCanvas(200, 200, 255, 255, 255);
    const productBox = { left: 40, top: 30, width: 120, height: 140 };
    paintRect(product, productBox, 160, 30, 90);
    const mask = rectMask(200, 200, productBox);
    const provider = new CorruptingMockProvider();

    const result = await compositeShot({
      productRgba: product,
      mask,
      provider,
      shot,
      template: {
        width: 320,
        height: 320,
        scenePrompt: "test plate",
        harmonizePrompt: "test harmonize",
        placement: { fill: 0.6 },
      },
      colorTransform: identityColorTransform,
    });

    expect(provider.harmonizeCalls).toBe(1);
    // Chunky product: the adaptive clamp must not have kicked in.
    expect(result.effectivePasteErodePx).toBe(PASTE_ERODE_PX);
    // The mask interior of the final image must be byte identical to the
    // product reference even though the mock repainted the whole frame. This
    // is asserted at the DERIVED QC default erosion (paste erode + ceil
    // feather + 1), the region the production QC checks: exact byte identity,
    // not just a small mean, so the feathered band can never leak regenerated
    // pixels into the checked region.
    const fidelity = await fidelityReport(result.productReference, result.finalRaw, result.canvasMask, {
      kind: "main",
    });
    expect(fidelity.erodePx).toBe(deriveQcErodePx());
    expect(fidelity.maskArea).toBeGreaterThan(0);
    expect(fidelity.exactByteShare).toBe(1);
    expect(fidelity.meanDeltaE).toBe(0);
    expect(fidelity.maxDeltaE).toBe(0);
    expect(fidelity.pass).toBe(true);
  });

  it("regression: a 4 px thin product survives byte identical via adaptive paste erosion", async () => {
    // A chain link or cable cross section: 4 px thick. The fixed 3 px erosion
    // used to annihilate this mask, so the output product was entirely
    // regenerated pixels and the old fidelityReport vacuously passed.
    const thinBox = { left: 20, top: 98, width: 160, height: 4 };
    const product = rawCanvas(200, 200, 255, 255, 255);
    paintRect(product, thinBox, 160, 30, 90);
    const mask = rectMask(200, 200, thinBox);

    const result = await compositeShot({
      productRgba: product,
      mask,
      provider: new CorruptingMockProvider(),
      shot,
      template: {
        width: 320,
        height: 320,
        scenePrompt: "p",
        harmonizePrompt: "h",
        // fill 0.5 of 320 = 160 target long side: scale 1, thickness stays 4.
        placement: { fill: 0.5 },
      },
    });

    // The clamp reduced the radius instead of erasing the paste mask.
    expect(result.effectivePasteErodePx).toBeLessThan(PASTE_ERODE_PX);
    expect(result.effectivePasteErodePx).toBeGreaterThanOrEqual(0);

    // Product pixels inside the effective paste region are byte identical
    // and the report is a real, non vacuous pass over a nonzero area.
    const fidelity = await fidelityReport(result.productReference, result.finalRaw, result.canvasMask, {
      erodePx: result.effectivePasteErodePx,
      kind: "main",
    });
    expect(fidelity.maskArea).toBeGreaterThan(0);
    expect(fidelity.exactByteShare).toBe(1);
    expect(fidelity.meanDeltaE).toBe(0);
    expect(fidelity.pass).toBe(true);
  });

  it("keeps the corrupted scene outside the product (harmonize output survives there)", async () => {
    const product = rawCanvas(200, 200, 255, 255, 255);
    const productBox = { left: 40, top: 30, width: 120, height: 140 };
    paintRect(product, productBox, 160, 30, 90);
    const mask = rectMask(200, 200, productBox);

    const result = await compositeShot({
      productRgba: product,
      mask,
      provider: new CorruptingMockProvider(),
      shot,
      template: { width: 320, height: 320, scenePrompt: "p", harmonizePrompt: "h" },
    });
    // A corner pixel is far from the product: it must show the harmonized
    // (neon green) scene, proving we did not just discard the model output.
    const o = (4 * result.finalRaw.width + 4) * 4;
    expect(result.finalRaw.data[o + 1]).toBe(255);
    expect(result.costMicros).toBe(2000);
  });

  it("applies a single global color transform through the hook", async () => {
    const product = rawCanvas(100, 100, 255, 255, 255);
    const productBox = { left: 20, top: 20, width: 60, height: 60 };
    paintRect(product, productBox, 100, 100, 100);
    const mask = rectMask(100, 100, productBox);

    const result = await compositeShot({
      productRgba: product,
      mask,
      provider: new CorruptingMockProvider(),
      shot,
      template: { width: 200, height: 200, scenePrompt: "p", harmonizePrompt: "h" },
      colorTransform: (img) => {
        const out = { ...img, data: Buffer.from(img.data) };
        for (let i = 0; i < out.data.length; i += 4) {
          out.data[i] = Math.min(255, out.data[i] + 10);
        }
        return out;
      },
    });
    const fidelity = await fidelityReport(result.productReference, result.finalRaw, result.canvasMask);
    // Reference already includes the transform, so paste back is still exact
    // at the derived QC default erosion.
    expect(fidelity.exactByteShare).toBe(1);
  });
});

const NEON: [number, number, number] = [20, 255, 20];
const PRODUCT: [number, number, number] = [160, 30, 90];

/**
 * A cutout the way Photoroom returns it: product pixels with their alpha,
 * fully transparent black everywhere else. rampPx > 0 fades the alpha out
 * over that many pixels around the box (hair, fur, glass). The mask is the
 * live runtime's alpha > 8 threshold.
 */
function cutout(
  size: number,
  box: { left: number; top: number; width: number; height: number },
  rampPx: number,
): { productRgba: RawImage; mask: RawMask } {
  const data = Buffer.alloc(size * size * 4, 0);
  const maskData = Buffer.alloc(size * size, 0);
  const right = box.left + box.width - 1;
  const bottom = box.top + box.height - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(box.left - x, 0, x - right);
      const dy = Math.max(box.top - y, 0, y - bottom);
      const d = Math.max(dx, dy);
      const alpha = d === 0 ? 255 : d <= rampPx ? Math.round(255 * (1 - d / (rampPx + 1))) : 0;
      if (alpha === 0) continue;
      const o = (y * size + x) * 4;
      data[o] = PRODUCT[0];
      data[o + 1] = PRODUCT[1];
      data[o + 2] = PRODUCT[2];
      data[o + 3] = alpha;
      if (alpha > 8) maskData[y * size + x] = 255;
    }
  }
  return { productRgba: { data, width: size, height: size, channels: 4 }, mask: { data: maskData, width: size, height: size } };
}

const cutoutBox = { left: 40, top: 30, width: 120, height: 140 };
const squareTemplate = { width: 320, height: 320, scenePrompt: "p", harmonizePrompt: "h", placement: { fill: 0.6 } };

describe("compositeShot edges", () => {
  // The feather reaches about 3 px, so the halo showed wherever the paste
  // erosion is smaller than that: thin products, where the adaptive clamp
  // takes it down to 0, and any caller passing a small pasteErodePx.
  const haloCases = [
    {
      name: "a thin product the adaptive clamp pastes at full mask",
      box: { left: 20, top: 98, width: 160, height: 4 },
      template: { ...squareTemplate, placement: { fill: 0.5 } },
      pasteErodePx: undefined,
    },
    { name: "a chunky product pasted with a 1 px erosion", box: cutoutBox, template: squareTemplate, pasteErodePx: 1 },
  ];
  for (const c of haloCases) it(`regression: no dark halo outside the mask for ${c.name} (Update.md 2.4)`, async () => {
    const result = await compositeShot({
      ...cutout(200, c.box, 0),
      provider: new CorruptingMockProvider(),
      shot,
      template: c.template,
      pasteErodePx: c.pasteErodePx,
    });
    expect(result.effectivePasteErodePx).toBeLessThan(PASTE_ERODE_PX);
    let outside = 0;
    let pasted = 0;
    let changed = 0;
    for (let i = 0; i < result.canvasMask.data.length; i++) {
      if (result.canvasMask.data[i] !== 0) continue;
      outside++;
      if (result.pasteAlpha.data[i] !== 0) pasted++;
      const o = i * 4;
      if (
        result.finalRaw.data[o] !== NEON[0] ||
        result.finalRaw.data[o + 1] !== NEON[1] ||
        result.finalRaw.data[o + 2] !== NEON[2]
      ) {
        changed++;
      }
    }
    expect(outside).toBeGreaterThan(0);
    // The feather used to spread about 4 px past the mask and paste the
    // cutout's transparent black surroundings there.
    expect(pasted).toBe(0);
    expect(changed).toBe(0);

    // Rule 3: the core is still byte identical.
    const fidelity = await fidelityReport(result.productReference, result.finalRaw, result.canvasMask, {
      kind: "main",
      erodePx: result.effectivePasteErodePx,
    });
    expect(fidelity.maskArea).toBeGreaterThan(0);
    expect(fidelity.exactByteShare).toBe(1);
    expect(fidelity.pass).toBe(true);
  });

  it("keeps the default chunky paste clear of the mask edge too", async () => {
    const result = await compositeShot({
      ...cutout(200, cutoutBox, 0),
      provider: new CorruptingMockProvider(),
      shot,
      template: squareTemplate,
    });
    let pasted = 0;
    for (let i = 0; i < result.canvasMask.data.length; i++) {
      if (result.canvasMask.data[i] === 0 && result.pasteAlpha.data[i] !== 0) pasted++;
    }
    expect(pasted).toBe(0);
  });

  it("blends soft cutout edges by the cutout alpha and keeps the core exact (Update.md 2.5)", async () => {
    const result = await compositeShot({
      ...cutout(200, cutoutBox, 10),
      provider: new CorruptingMockProvider(),
      shot,
      template: squareTemplate,
    });
    const core = await erode(result.canvasMask, result.effectivePasteErodePx);
    const violations = { outside: 0, core: 0, overCutout: 0, blend: 0, dark: 0 };
    let band = 0;
    let softBlended = 0;
    for (let i = 0; i < result.pasteAlpha.data.length; i++) {
      const a = result.pasteAlpha.data[i];
      const o = i * 4;
      if (result.canvasMask.data[i] === 0) {
        if (a !== 0) violations.outside++;
      } else if (core.data[i] !== 0) {
        if (a !== 255) violations.core++;
      } else {
        band++;
        // Outside the core the paste never outweighs the cutout's own alpha.
        if (a > result.cutoutAlpha.data[i]) violations.overCutout++;
        if (a > 0 && result.cutoutAlpha.data[i] < 255) softBlended++;
        // And the pixel is exactly that blend of product over scene.
        for (let c = 0; c < 3; c++) {
          const expected = Math.round((a * result.productReference.data[o + c] + (255 - a) * NEON[c]) / 255);
          if (result.finalRaw.data[o + c] !== expected) violations.blend++;
        }
      }
      // No dark fringe anywhere: green never drops below the product's own
      // green (the darker of product and scene in that channel), give or
      // take the resize kernel's ringing. A black fringe would read near 0.
      if (result.finalRaw.data[o + 1] < PRODUCT[1] - 5) violations.dark++;
    }
    expect(violations).toEqual({ outside: 0, core: 0, overCutout: 0, blend: 0, dark: 0 });
    expect(band).toBeGreaterThan(0);
    expect(softBlended).toBeGreaterThan(0);

    const fidelity = await fidelityReport(result.productReference, result.finalRaw, result.canvasMask, {
      kind: "main",
    });
    expect(fidelity.exactByteShare).toBe(1);
    expect(fidelity.pass).toBe(true);
  });

  it("shows soft edges in the draft sent to harmonize by the cutout alpha", async () => {
    const provider = new ShapeMockProvider("draft-probe");
    const result = await compositeShot({ ...cutout(200, cutoutBox, 10), provider, shot, template: squareTemplate });
    const draft = await decodeToRgba(provider.lastDraft!);
    const plateGreen = 110;
    let faint = 0;
    let tooSolid = 0;
    let dark = 0;
    for (let i = 0; i < draft.width * draft.height; i++) {
      const g = draft.data[i * 4 + 1];
      // Never the black the premultiplied resize leaves in transparent areas.
      if (g < PRODUCT[1] - 5) dark++;
      const a = result.cutoutAlpha.data[i];
      if (result.canvasMask.data[i] !== 0 && a > 0 && a < 100) {
        faint++;
        // A faint cutout pixel shows mostly plate. The old draft used the
        // binary mask as weight and painted it solid product color.
        const expected = PRODUCT[1] + ((plateGreen - PRODUCT[1]) * (255 - a)) / 255;
        if (g < expected - 3) tooSolid++;
      }
    }
    expect(faint).toBeGreaterThan(0);
    expect(tooSolid).toBe(0);
    expect(dark).toBe(0);
  });
});

/**
 * Plate and harmonize provider with a controllable harmonize output size.
 * Records the harmonize input so tests can check the canvas size travels
 * with the draft.
 */
class ShapeMockProvider implements Provider {
  readonly kind = "image" as const;
  harmonizeCalls = 0;
  lastDraft: Buffer | null = null;
  lastHarmonizeInput: HarmonizeInput | null = null;

  /** Set by a test to make this a cost aware provider. */
  estimateCostMicros?: () => number;

  constructor(
    readonly name: string,
    private readonly harmonizeSize?: (w: number, h: number) => [number, number],
  ) {}

  supports(task: string): boolean {
    return task === "scene_plate" || task === "harmonize";
  }

  async invoke<TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    if (req.task === "scene_plate") {
      const { width, height } = req.input as ScenePlateInput;
      const png = await sharp({ create: { width, height, channels: 4, background: { r: 90, g: 110, b: 130, alpha: 1 } } })
        .png()
        .toBuffer();
      return { output: { png } as TOut, costMicros: 1200 };
    }
    this.harmonizeCalls++;
    const input = req.input as HarmonizeInput;
    this.lastHarmonizeInput = input;
    this.lastDraft = input.png;
    const [w, h] = this.harmonizeSize ? this.harmonizeSize(input.width, input.height) : [input.width, input.height];
    const png = await sharp(input.png).resize(w, h, { fit: "fill" }).png().toBuffer();
    return { output: { png } as TOut, costMicros: 800 };
  }
}

/** 16:9 whatever the canvas asks for. */
const sixteenByNine = (_w: number, h: number): [number, number] => [Math.round((h * 16) / 9), h];

describe("compositeShot harmonize aspect ratio (Update.md 2.14)", () => {
  it("sends the canvas size with the draft", async () => {
    const provider = new ShapeMockProvider("probe");
    await compositeShot({ ...cutout(200, cutoutBox, 0), provider, shot, template: squareTemplate });
    expect(provider.lastHarmonizeInput).toMatchObject({ width: 320, height: 320 });
  });

  it("rejects a 16:9 harmonize output for a 1:1 canvas instead of cropping it out of register", async () => {
    const provider = new ShapeMockProvider("wide", sixteenByNine);
    const attempt = compositeShot({ ...cutout(200, cutoutBox, 0), provider, shot, template: squareTemplate });
    await expect(attempt).rejects.toBeInstanceOf(HarmonizeAspectError);
    const err = (await attempt.catch((e: unknown) => e)) as HarmonizeAspectError;
    expect(err.retryable).toBe(false);
    expect(err.task).toBe("harmonize");
    expect(err.got).toEqual({ width: 569, height: 320 });
    // The plate and the rejected harmonize were both paid for.
    expect(err.costMicros).toBe(2000);
    // A ProviderError the router meters at that cost, never an outage.
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.billedCostMicros).toBe(2000);
    expect(err.transient).toBe(false);
  });

  it("carries the rejected output's cost as billed spend from the guard", async () => {
    const guarded = withHarmonizeAspectGuard(new ShapeMockProvider("wide", sixteenByNine));
    const png = await sharp({ create: { width: 320, height: 320, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } })
      .png()
      .toBuffer();
    const err = (await guarded
      .invoke({ task: "harmonize", input: { prompt: "p", png, width: 320, height: 320 } })
      .catch((e: unknown) => e)) as HarmonizeAspectError;
    expect(err).toBeInstanceOf(HarmonizeAspectError);
    expect(err.costMicros).toBe(800);
    expect(err.billedCostMicros).toBe(800);
    expect(err.transient).toBe(false);
    expect(err.retryable).toBe(false);
    expect(err.cause).toBeUndefined();
  });

  it("fails over to the next provider when a guarded provider returns 16:9 for a 1:1 canvas", async () => {
    const wide = new ShapeMockProvider("wide", sixteenByNine);
    const good = new ShapeMockProvider("good");
    // Cost capped calls need an estimate; each call reserves 1000 up front.
    wide.estimateCostMicros = () => 1000;
    good.estimateCostMicros = () => 1000;
    const registry = new ProviderRegistry();
    registry.register(withHarmonizeAspectGuard(wide));
    registry.register(withHarmonizeAspectGuard(good));
    const routing = { scene_plate: ["wide", "good"], harmonize: ["wide", "good"] };
    const meter = new InMemoryCostMeter();
    const breakerStore = new InMemoryBreakerStore();
    const capStore = new InMemoryCapStore();
    const spendCaps = new SpendCaps(capStore, () => new Date("2026-09-28T12:00:00Z"));
    const jobId = "job-aspect";
    const routed: Provider = {
      name: "chain",
      kind: "image",
      supports: (task) => task in routing,
      invoke: async <TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> => {
        const res = await callWithFailover<TIn, TOut>(registry, routing, meter, breakerStore, req, {
          caps: [
            { spendCaps, capKind: "pack", jobId },
            { spendCaps, capKind: "global_day" },
          ],
        });
        return { output: res.output, costMicros: res.costMicros };
      },
    };

    const result = await compositeShot({ ...cutout(200, cutoutBox, 0), provider: routed, shot, template: squareTemplate });

    // Not retryable: one call to the wide provider, then straight to the next.
    expect(wide.harmonizeCalls).toBe(1);
    expect(good.harmonizeCalls).toBe(1);
    const failed = meter.entries.filter((e) => !e.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ provider: "wide", task: "harmonize" });
    expect(failed[0].error).toMatch(/569x320 does not match the 320x320/);
    // The rejected output was paid for, so it is metered at its cost (rule 4).
    expect(failed[0].costMicros).toBe(800);
    // A shape mismatch is not an outage, so it never counts toward the breaker.
    expect(Number((await breakerStore.get("breaker:wide:failures")) ?? "0")).toBe(0);
    // The spend caps keep it too: the plate (1200), the rejected harmonize
    // (800) and the accepted harmonize (800).
    const metered = meter.entries.reduce((sum, e) => sum + e.costMicros, 0);
    expect(metered).toBe(2800);
    expect(await capStore.get(`caps:pack:${jobId}`)).toBe(2800);
    expect(await capStore.get("caps:global:2026-09-28")).toBe(2800);

    expect(result.finalRaw.width).toBe(320);
    const fidelity = await fidelityReport(result.productReference, result.finalRaw, result.canvasMask, {
      kind: "main",
    });
    expect(fidelity.exactByteShare).toBe(1);
  });

  it("accepts a provider's snapped native size and stretches it back into register", async () => {
    // 320x314 is about 2 percent off square, inside the tolerance.
    const provider = new ShapeMockProvider("snapped", (w, h) => [w, h - 6]);
    const result = await compositeShot({ ...cutout(200, cutoutBox, 0), provider, shot, template: squareTemplate });
    expect(result.finalRaw.width).toBe(320);
    expect(result.finalRaw.height).toBe(320);
    const fidelity = await fidelityReport(result.productReference, result.finalRaw, result.canvasMask, {
      kind: "main",
    });
    expect(fidelity.exactByteShare).toBe(1);
  });

  it("measures aspect drift against the tolerance", () => {
    expect(aspectDrift(1024, 1024, 2000, 2000)).toBe(0);
    expect(aspectDrift(569, 320, 320, 320)).toBeGreaterThan(HARMONIZE_ASPECT_TOLERANCE);
    // A 4:5 canvas answered at a grid snapped 896x1152 is accepted.
    expect(aspectDrift(896, 1152, 1080, 1350)).toBeLessThan(HARMONIZE_ASPECT_TOLERANCE);
    // A 3:4 answer to a 4:5 canvas is a different framing and is not.
    expect(aspectDrift(864, 1152, 1080, 1350)).toBeGreaterThan(HARMONIZE_ASPECT_TOLERANCE);
    expect(aspectDrift(0, 10, 10, 10)).toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps cost estimates working through the guard", () => {
    const withEstimate = new ShapeMockProvider("est");
    withEstimate.estimateCostMicros = () => 4321;
    const guarded = withHarmonizeAspectGuard(withEstimate);
    expect(guarded.name).toBe("est");
    expect(guarded.supports("harmonize")).toBe(true);
    expect(guarded.estimateCostMicros?.({ task: "harmonize", input: {} })).toBe(4321);
    expect(withHarmonizeAspectGuard(new ShapeMockProvider("plain")).estimateCostMicros).toBeUndefined();
  });
});

function verdict(pass: boolean, hint = "even out the shadow"): QCVerdict {
  return { pass, fidelity: pass ? 0.99 : 0.4, issues: pass ? [] : ["bad_shadow"], repairHint: hint };
}

describe("planRetry", () => {
  it("accepts on a passing verdict at any attempt", () => {
    expect(planRetry(1, verdict(true))).toEqual({ action: "accept" });
    expect(planRetry(4, verdict(true))).toEqual({ action: "accept" });
  });

  it("retries with the repair hint for attempts 1 and 2", () => {
    expect(planRetry(1, verdict(false))).toEqual({
      action: "retry",
      nextAttempt: 2,
      repairHint: "even out the shadow",
    });
    expect(planRetry(2, verdict(false))).toEqual({
      action: "retry",
      nextAttempt: 3,
      repairHint: "even out the shadow",
    });
  });

  it("switches to the fallback provider after the third failed attempt", () => {
    expect(planRetry(3, verdict(false))).toEqual({
      action: "fallback_provider",
      nextAttempt: 4,
      repairHint: "even out the shadow",
    });
  });

  it("marks needs_review when the fallback also fails", () => {
    expect(planRetry(4, verdict(false))).toEqual({ action: "needs_review" });
    expect(planRetry(7, verdict(false))).toEqual({ action: "needs_review" });
  });

  it("rejects invalid attempt numbers", () => {
    expect(() => planRetry(0, verdict(false))).toThrow();
    expect(() => planRetry(1.5, verdict(false))).toThrow();
  });
});
