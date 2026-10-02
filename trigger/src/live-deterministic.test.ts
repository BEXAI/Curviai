import { describe, expect, it } from "vitest";
import {
  boundingBoxOfMask,
  decodeToRgba,
  encodePng,
  fidelityReport,
  maskToSharp,
  pixelChecks,
  qcKindForSpec,
  solidCanvas,
  type RawImage,
  type RawMask,
  type Shot,
} from "@curvi/pipeline";
import { stillStyle } from "@curvi/pipeline/seed";
import { tintInsideMask } from "@curvi/pipeline/testing";
import { getSpec } from "@curvi/specs";
import { DETERMINISTIC_LIVE_TYPES, renderDeterministicShot } from "./live-deterministic";
import type { LiveProduct, StillRender } from "./live-product";
import { ShotUnavailableError } from "./pipeline-runner";

/** Four flat colored quadrants, so we can check colors survive scaling. */
const QUADRANTS: ReadonlyArray<readonly [number, number, number]> = [
  [180, 40, 40],
  [30, 60, 150],
  [20, 20, 20],
  [230, 190, 60],
];

const W = 240;
const H = 180;
const BOX = { left: 40, top: 30, right: 200, bottom: 150 };

async function syntheticProduct(opts: { empty?: boolean } = {}): Promise<LiveProduct> {
  // Stray color outside the product with alpha 0: it must never show.
  const productRgba = solidCanvas(W, H, 120, 90, 60, 0);
  const maskData = Buffer.alloc(W * H, 0);
  if (!opts.empty) {
    const midX = (BOX.left + BOX.right) / 2;
    const midY = (BOX.top + BOX.bottom) / 2;
    for (let y = BOX.top; y < BOX.bottom; y++) {
      for (let x = BOX.left; x < BOX.right; x++) {
        const q = (y < midY ? 0 : 2) + (x < midX ? 0 : 1);
        const o = (y * W + x) * 4;
        productRgba.data[o] = QUADRANTS[q][0];
        productRgba.data[o + 1] = QUADRANTS[q][1];
        productRgba.data[o + 2] = QUADRANTS[q][2];
        productRgba.data[o + 3] = 255;
        maskData[y * W + x] = 255;
      }
    }
  }
  const mask: RawMask = { data: maskData, width: W, height: H };
  return {
    productRgba,
    mask,
    productPng: await encodePng(productRgba),
    maskPng: await maskToSharp(mask).png().toBuffer(),
  };
}

/**
 * Textured source size. A realistic cutout resolution: at the tiny W x H
 * above the helpers upscale about 12x, and the lanczos anti aliased edge
 * blend then grows wider than fidelity's derived erosion (7 px).
 */
const TW = 800;
const TH = 600;

/**
 * Textured cutout: gradients plus seeded noise inside an ellipse (soft,
 * non rectangular edge), alpha 0 and stray color outside. Flat colors would
 * let a tinted or regenerated product slip through a fidelity check.
 */
async function texturedProduct(W = TW, H = TH): Promise<LiveProduct> {
  const productRgba = solidCanvas(W, H, 120, 90, 60, 0);
  const maskData = Buffer.alloc(W * H, 0);
  let seed = 987654;
  const noise = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 31) - 15;
  };
  const cx = W / 2;
  const cy = H / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x + 0.5 - cx) / (W * 0.34);
      const dy = (y + 0.5 - cy) / (H * 0.4);
      if (dx * dx + dy * dy > 1) continue;
      const o = (y * W + x) * 4;
      productRgba.data[o] = Math.round(70 + (110 * x) / W + noise());
      productRgba.data[o + 1] = Math.round(60 + (120 * y) / H + noise());
      productRgba.data[o + 2] = Math.round(160 - (70 * (x / W + y / H)) / 2 + noise());
      productRgba.data[o + 3] = 255;
      maskData[y * W + x] = 255;
    }
  }
  const mask: RawMask = { data: maskData, width: W, height: H };
  return {
    productRgba,
    mask,
    productPng: await encodePng(productRgba),
    maskPng: await maskToSharp(mask).png().toBuffer(),
  };
}

function shotOf(type: Shot["type"], channel: string, method: Shot["method"] = "deterministic"): Shot {
  return {
    id: `s01_${type}`,
    type,
    sourceMediaId: "source_1",
    method,
    channels: [channel],
    stylePreset: "none",
    credits: 1,
    priority: 1,
  };
}

function pixel(image: RawImage, x: number, y: number): [number, number, number, number] {
  const o = (y * image.width + x) * 4;
  return [image.data[o], image.data[o + 1], image.data[o + 2], image.data[o + 3]];
}

async function expectShipsCleanly(render: StillRender, channel: string): Promise<void> {
  const spec = getSpec(channel);
  if (spec.width) expect(render.image.width).toBe(spec.width);
  if (spec.height) expect(render.image.height).toBe(spec.height);
  if (spec.formats) expect(spec.formats as readonly string[]).toContain(render.encoded.format);
  if (spec.maxBytes) expect(render.encoded.buffer.length).toBeLessThanOrEqual(spec.maxBytes);

  // The returned pixels are exactly the pixels of the file that ships.
  const decoded = await decodeToRgba(render.encoded.buffer);
  expect(decoded.width).toBe(render.image.width);
  expect(decoded.height).toBe(render.image.height);
  expect(decoded.data.equals(render.image.data)).toBe(true);
  expect(render.mask?.width).toBe(render.image.width);
  expect(render.mask?.height).toBe(render.image.height);

  const report = await pixelChecks(render.image, render.mask, spec, {
    encoded: { bytes: render.encoded.buffer.length, format: render.encoded.format },
    edgeMarginPx: 2,
  });
  expect(report.checks.filter((c) => !c.pass)).toEqual([]);
  expect(report.pass).toBe(true);
}

/** Each quadrant center in the output keeps its source color. */
function expectProductColorsKept(render: StillRender, tolerance: number): void {
  if (!render.mask) throw new Error("expected a mask");
  const bbox = boundingBoxOfMask(render.mask);
  if (!bbox) throw new Error("expected a product in the mask");
  const centers = [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ];
  centers.forEach(([fx, fy], q) => {
    const [r, g, b] = pixel(
      render.image,
      Math.round(bbox.left + fx * bbox.width),
      Math.round(bbox.top + fy * bbox.height),
    );
    expect(Math.abs(r - QUADRANTS[q][0])).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(g - QUADRANTS[q][1])).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(b - QUADRANTS[q][2])).toBeLessThanOrEqual(tolerance);
  });
}

function hexRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Sweep background at the left edge middle row, per makeSweep's gradient. */
function expectSweepColor(render: StillRender, hex: string): void {
  const y = Math.floor(render.image.height / 2);
  const factor = 1.06 - (0.12 * y) / (render.image.height - 1);
  const [r, g, b] = pixel(render.image, 4, y);
  const [er, eg, eb] = hexRgb(hex).map((c) => Math.min(255, Math.round(c * factor)));
  expect(Math.abs(r - er)).toBeLessThanOrEqual(3);
  expect(Math.abs(g - eg)).toBeLessThanOrEqual(3);
  expect(Math.abs(b - eb)).toBeLessThanOrEqual(3);
}

describe("renderDeterministicShot", () => {
  it("lists exactly the deterministic types it renders", () => {
    expect([...DETERMINISTIC_LIVE_TYPES].sort()).toEqual(
      [
        "alt_angle_white",
        "amazon_main",
        "collection_thumb",
        "cutout_png",
        "original_photo",
        "sweep_brand",
        "sweep_gray",
      ].sort(),
    );
  });

  it("amazon_main: pure white background, fill in range, passes main QC", async () => {
    const product = await syntheticProduct();
    const render = await renderDeterministicShot({ shot: shotOf("amazon_main", "amazon.main"), product });
    await expectShipsCleanly(render, "amazon.main");

    const mask = render.mask!;
    for (let i = 0; i < mask.data.length; i++) {
      if (mask.data[i] !== 0) continue;
      const o = i * 4;
      if (render.image.data[o] !== 255 || render.image.data[o + 1] !== 255 || render.image.data[o + 2] !== 255) {
        throw new Error(`pixel ${i} outside the mask is not pure white`);
      }
    }
    expectProductColorsKept(render, 4);
  });

  for (const channel of ["amazon.secondary", "shopify.product", "google.merchant.lifestyle"]) {
    it(`alt_angle_white on ${channel}: white treatment at the spec size`, async () => {
      const product = await syntheticProduct();
      const render = await renderDeterministicShot({ shot: shotOf("alt_angle_white", channel), product });
      await expectShipsCleanly(render, channel);
      expect(pixel(render.image, 0, 0).slice(0, 3)).toEqual([255, 255, 255]);
      expectProductColorsKept(render, 4);
    });
  }

  for (const channel of ["amazon.secondary", "shopify.product"]) {
    it(`cutout_png on ${channel}: transparent PNG with a mask from alpha`, async () => {
      const product = await syntheticProduct();
      const render = await renderDeterministicShot({ shot: shotOf("cutout_png", channel), product });
      await expectShipsCleanly(render, channel);
      expect(render.encoded.format).toBe("png");
      expect(pixel(render.image, 0, 0)[3]).toBe(0);
      const mask = render.mask!;
      for (let i = 0; i < mask.data.length; i++) {
        expect(mask.data[i] === 255).toBe(render.image.data[i * 4 + 3] > 0);
        if (i > 20_000) break;
      }
      expectProductColorsKept(render, 2);
    });
  }

  it("cutout_png flattens onto white when the spec takes no transparency", async () => {
    const product = await syntheticProduct();
    const render = await renderDeterministicShot({ shot: shotOf("cutout_png", "amazon.main"), product });
    await expectShipsCleanly(render, "amazon.main");
    expect(pixel(render.image, 0, 0)).toEqual([255, 255, 255, 255]);
  });

  it("sweep_gray uses the seeded sweep gray", async () => {
    const product = await syntheticProduct();
    const render = await renderDeterministicShot({ shot: shotOf("sweep_gray", "amazon.secondary"), product });
    await expectShipsCleanly(render, "amazon.secondary");
    expectSweepColor(render, stillStyle.sweepGrayHex);
    expectProductColorsKept(render, 4);
  });

  it("sweep_brand uses the first valid brand kit color", async () => {
    const product = await syntheticProduct();
    const render = await renderDeterministicShot({
      shot: shotOf("sweep_brand", "shopify.product"),
      product,
      brandColors: ["red", "#12345", "#1A7F3C", "#FFFFFF"],
    });
    await expectShipsCleanly(render, "shopify.product");
    expectSweepColor(render, "#1A7F3C");
    expectProductColorsKept(render, 4);
  });

  it("sweep_brand falls back to the seeded brand color without a brand kit", async () => {
    const product = await syntheticProduct();
    for (const brandColors of [undefined, [], ["not a color"]]) {
      const render = await renderDeterministicShot({
        shot: shotOf("sweep_brand", "amazon.secondary"),
        product,
        brandColors,
      });
      await expectShipsCleanly(render, "amazon.secondary");
      expectSweepColor(render, stillStyle.fallbackBrandHex);
    }
  });

  it("collection_thumb: product on white at the Shopify product size", async () => {
    const product = await syntheticProduct();
    const render = await renderDeterministicShot({ shot: shotOf("collection_thumb", "shopify.product"), product });
    await expectShipsCleanly(render, "shopify.product");
    expect(pixel(render.image, 0, 0).slice(0, 3)).toEqual([255, 255, 255]);
    expectProductColorsKept(render, 4);
  });

  it("refuses a sweep on a solid background channel", async () => {
    const product = await syntheticProduct();
    await expect(
      renderDeterministicShot({ shot: shotOf("sweep_gray", "amazon.main"), product }),
    ).rejects.toBeInstanceOf(ShotUnavailableError);
  });

  it("throws ShotUnavailableError for types it cannot render honestly", async () => {
    const product = await syntheticProduct();
    await expect(
      renderDeterministicShot({ shot: shotOf("social_1x1", "meta.feed_1x1"), product }),
    ).rejects.toBeInstanceOf(ShotUnavailableError);
    await expect(
      renderDeterministicShot({ shot: shotOf("amazon_main", "amazon.main", "composite_generate"), product }),
    ).rejects.toBeInstanceOf(ShotUnavailableError);
  });

  it("throws ShotUnavailableError when the cutout found no product", async () => {
    const product = await syntheticProduct({ empty: true });
    await expect(
      renderDeterministicShot({ shot: shotOf("amazon_main", "amazon.main"), product }),
    ).rejects.toBeInstanceOf(ShotUnavailableError);
  });
});

describe("renderDeterministicShot rule 3 product fidelity", () => {
  const rule3Cases: { type: Shot["type"]; channel: string }[] = [
    { type: "amazon_main", channel: "amazon.main" },
    { type: "alt_angle_white", channel: "amazon.secondary" },
    { type: "cutout_png", channel: "shopify.product" },
    { type: "cutout_png", channel: "amazon.main" },
    { type: "sweep_gray", channel: "amazon.secondary" },
    { type: "sweep_brand", channel: "shopify.product" },
    { type: "collection_thumb", channel: "shopify.product" },
  ];

  for (const { type, channel } of rule3Cases) {
    it(`${type} on ${channel}: shipped product pixels match the placed cutout`, async () => {
      const spec = getSpec(channel);
      const render = await renderDeterministicShot({
        shot: shotOf(type, channel),
        product: await texturedProduct(),
        brandColors: ["#1A7F3C"],
      });
      await expectShipsCleanly(render, channel);
      const mask = render.mask;
      if (!mask) throw new Error("expected a mask");
      expect(render.productReference.width).toBe(render.image.width);
      expect(render.productReference.height).toBe(render.image.height);

      const kind = qcKindForSpec(spec);
      const report = await fidelityReport(render.productReference, render.image, mask, { kind });
      expect(report.issues).toEqual([]);
      expect(report.pass).toBe(true);
      expect(report.maskArea).toBeGreaterThan(1000);

      // The check bites: a slight tint inside the product fails it.
      const tinted = await fidelityReport(render.productReference, tintInsideMask(render.image, mask, 25), mask, {
        kind,
      });
      expect(tinted.pass).toBe(false);
    });
  }
});
