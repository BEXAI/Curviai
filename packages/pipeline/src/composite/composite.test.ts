import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { Provider, ProviderRequest, ProviderResponse } from "@curvi/ai";
import { deriveQcErodePx, fidelityReport } from "../qc/fidelity";
import { decodeToRgba } from "../raw";
import { paintRect, rawCanvas, rectMask } from "../testutil";
import type { QCVerdict, Shot } from "../schemas";
import {
  PASTE_ERODE_PX,
  compositeShot,
  identityColorTransform,
  planRetry,
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
