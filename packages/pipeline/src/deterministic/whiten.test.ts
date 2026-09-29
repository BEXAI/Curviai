import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { getSpec, type ChannelSpec } from "@curvi/specs";
import { decodeMask, decodeToRgba, maskFromAlpha, type RawImage, type RawMask } from "../raw";
import { boundingBoxOfMask } from "../mask";
import { fidelityReport } from "../qc/fidelity";
import { qcKindForSpec } from "../qc/pixelChecks";
import { rectProduct } from "../testutil";
import { productSizeFillFor } from "../output-options";
import { canvasDefaults } from "../seed/templates";
import {
  buildProductReference,
  encodeUnderLimit,
  makeAmazonMain,
  makeCutoutPng,
  makeOnBackground,
  makeSweep,
  MIN_JPEG_QUALITY,
  OutputTooLargeError,
  PRODUCT_RESIZE_KERNEL,
  stepDownSizes,
} from "./whiten";

/**
 * Textured cutout (gradients plus seeded noise inside an ellipse, alpha 0
 * outside), so a fidelity check compares real detail, not one flat color.
 */
async function texturedCutout(size = 256): Promise<{ png: Buffer; maskPng: Buffer; rgba: RawImage; mask: RawMask }> {
  const data = Buffer.alloc(size * size * 4, 0);
  const maskData = Buffer.alloc(size * size, 0);
  let seed = 12345;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 31) - 15;
  };
  const cx = size / 2;
  const cy = size / 2;
  const rx = size * 0.32;
  const ry = size * 0.4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy > 1) continue;
      const o = (y * size + x) * 4;
      data[o] = Math.round(60 + (120 * x) / size + noise());
      data[o + 1] = Math.round(70 + (100 * y) / size + noise());
      data[o + 2] = Math.round(150 - (60 * (x + y)) / (2 * size) + noise());
      data[o + 3] = 255;
      maskData[y * size + x] = 255;
    }
  }
  const rgba: RawImage = { data, width: size, height: size, channels: 4 };
  const mask: RawMask = { data: maskData, width: size, height: size };
  const png = await sharp(data, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
  const maskPng = await sharp(maskData, { raw: { width: size, height: size, channels: 1 } }).png().toBuffer();
  return { png, maskPng, rgba, mask };
}

/** Copy of image with red raised by amount inside mask, like a stray tint. */
function tintInsideMask(image: RawImage, mask: RawMask, amount: number): RawImage {
  const data = Buffer.from(image.data);
  for (let i = 0; i < mask.data.length; i++) {
    if (mask.data[i] === 0) continue;
    data[i * 4] = Math.min(255, data[i * 4] + amount);
  }
  return { ...image, data };
}

/** Small spec so most tests stay fast; same rules as amazon.main. */
const smallSpec: ChannelSpec = {
  id: "amazon.main",
  verified: true,
  width: 512,
  height: 512,
  formats: ["jpg", "png"],
  maxBytes: 10_000_000,
  background: { type: "solid", rgb: [255, 255, 255], tolerance: 0 },
  fill: { min: 0.85, max: 0.9 },
  textAllowed: false,
};

describe("makeAmazonMain", () => {
  it("forces every pixel outside the mask to pure white", async () => {
    const product = await rectProduct(256, "rgb(30,80,160)", { background: 128 });
    const result = await makeAmazonMain(product.source, product.mask, smallSpec);
    const { raw, mask } = result;
    let outside = 0;
    let white = 0;
    for (let i = 0; i < mask.data.length; i++) {
      if (mask.data[i] !== 0) {
        continue;
      }
      outside++;
      const o = i * 4;
      if (raw.data[o] === 255 && raw.data[o + 1] === 255 && raw.data[o + 2] === 255) {
        white++;
      }
    }
    expect(outside).toBeGreaterThan(0);
    expect(white / outside).toBe(1);
  });

  it("fills the canvas within the spec fill band", async () => {
    const product = await rectProduct(256);
    const result = await makeAmazonMain(product.source, product.mask, smallSpec);
    expect(result.fillRatio).toBeGreaterThanOrEqual(0.85);
    expect(result.fillRatio).toBeLessThanOrEqual(0.9);
    const bbox = boundingBoxOfMask(result.mask);
    expect(bbox).not.toBeNull();
    const measured = Math.max(bbox!.width, bbox!.height) / 512;
    expect(measured).toBeGreaterThanOrEqual(0.85);
    expect(measured).toBeLessThanOrEqual(0.9);
  });

  it("meets the real amazon.main spec minimum long side of 1600", async () => {
    const spec = getSpec("amazon.main");
    const product = await rectProduct(320, "rgb(90,60,20)");
    const result = await makeAmazonMain(product.source, product.mask, spec);
    expect(Math.max(result.width, result.height)).toBeGreaterThanOrEqual(1600);
    expect(result.width).toBe(spec.width);
    expect(result.height).toBe(spec.height);
    expect(result.jpeg.length).toBeLessThanOrEqual(spec.maxBytes!);
    const meta = await sharp(result.jpeg).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(spec.width);
  });

  it("keeps product pixels intact before encoding (mask interior matches lanczos resample)", async () => {
    const product = await rectProduct(256, "rgb(200,10,10)");
    const result = await makeAmazonMain(product.source, product.mask, smallSpec);
    // Deep inside the mask the pixel must be the product color, untouched by
    // any whitening.
    const bbox = boundingBoxOfMask(result.mask)!;
    const cx = bbox.left + Math.floor(bbox.width / 2);
    const cy = bbox.top + Math.floor(bbox.height / 2);
    const o = (cy * result.width + cx) * 4;
    expect(result.raw.data[o]).toBeGreaterThan(150);
    expect(result.raw.data[o + 1]).toBeLessThan(60);
    expect(result.raw.data[o + 2]).toBeLessThan(60);
  });

  it("rejects an empty mask", async () => {
    const product = await rectProduct(64);
    const emptyMask = await sharp(Buffer.alloc(64 * 64, 0), {
      raw: { width: 64, height: 64, channels: 1 },
    })
      .png()
      .toBuffer();
    await expect(makeAmazonMain(product.source, emptyMask, smallSpec)).rejects.toThrow(/empty/i);
  });

  it("rejects a mask that does not match the source size", async () => {
    const product = await rectProduct(64);
    const wrongMask = await sharp(Buffer.alloc(32 * 32, 255), {
      raw: { width: 32, height: 32, channels: 1 },
    })
      .png()
      .toBuffer();
    await expect(makeAmazonMain(product.source, wrongMask, smallSpec)).rejects.toThrow(/size/i);
  });
});

describe("product size in the frame (PHASE_15 P1)", () => {
  it("places a larger or smaller product on an open spec, and keeps amazon.main inside its fill range", async () => {
    const product = await rectProduct(256, "rgb(30,80,160)", { background: 128 });
    const open = getSpec("meta.feed_1x1");
    const white: [number, number, number] = [255, 255, 255];
    const fills: number[] = [];
    for (const size of ["smaller", "standard", "larger"] as const) {
      const placed = await makeOnBackground(product.source, product.mask, open, {
        rgb: white,
        fill: productSizeFillFor(open, { productSize: size }),
      });
      fills.push(placed.fillRatio);
      const main = await makeOnBackground(product.source, product.mask, getSpec("amazon.main"), {
        rgb: white,
        fill: productSizeFillFor(getSpec("amazon.main"), { productSize: size }),
      });
      expect(main.fillRatio).toBeGreaterThanOrEqual(0.85 - 0.005);
      expect(main.fillRatio).toBeLessThanOrEqual(0.9 + 0.005);
    }
    expect(fills[0]).toBeLessThan(fills[1]);
    expect(fills[1]).toBeLessThan(fills[2]);
    expect(fills[2]).toBeLessThanOrEqual(canvasDefaults.maxAxisShare);
  });
});

describe("makeCutoutPng", () => {
  it("produces a transparent png trimmed to the product box", async () => {
    const product = await rectProduct(256);
    const cutout = await makeCutoutPng(product.source, product.mask);
    const meta = await sharp(cutout.png).metadata();
    expect(meta.format).toBe("png");
    expect(meta.hasAlpha).toBe(true);
    expect(cutout.width).toBeLessThan(256);
    const alphaMask = await maskFromAlpha(cutout.png);
    // Corners of the trimmed box may touch the product; center must be opaque.
    const center = Math.floor(alphaMask.height / 2) * alphaMask.width + Math.floor(alphaMask.width / 2);
    expect(alphaMask.data[center]).toBe(255);
  });
});

describe("makeSweep", () => {
  it("builds a gradient background with the product composited", async () => {
    const product = await rectProduct(256, "rgb(20,120,50)");
    const sweep = await makeSweep(product.source, product.mask, "#DDDDDD", {
      width: 512,
      height: 512,
    });
    const raw = await decodeToRgba(sweep.jpeg);
    // Top background lighter than bottom background (vertical sweep).
    const top = raw.data[(4 * raw.width + 4) * 4];
    const bottom = raw.data[((raw.height - 5) * raw.width + 4) * 4];
    expect(top).toBeGreaterThan(bottom);
    // Product visible near center.
    const bbox = boundingBoxOfMask(sweep.mask)!;
    const cx = bbox.left + Math.floor(bbox.width / 2);
    const cy = bbox.top + Math.floor(bbox.height / 2);
    const o = (cy * raw.width + cx) * 4;
    expect(raw.data[o + 1]).toBeGreaterThan(raw.data[o]);
  });
});

describe("product placement and rule 3 reference", () => {
  it("makeAmazonMain reports a placement whose reference matches the raw product bytes", async () => {
    const cut = await texturedCutout();
    const result = await makeAmazonMain(cut.png, cut.maskPng, smallSpec);
    const { placement } = result;
    expect(placement.kernel).toBe(PRODUCT_RESIZE_KERNEL);
    expect(placement.crop).toEqual(boundingBoxOfMask(cut.mask));
    expect(boundingBoxOfMask(result.mask)).toEqual({
      left: placement.left,
      top: placement.top,
      width: placement.width,
      height: placement.height,
    });

    const reference = await buildProductReference(await decodeToRgba(cut.png), placement, result.width, result.height);
    const onRaw = await fidelityReport(reference, result.raw, result.mask, { kind: qcKindForSpec(smallSpec) });
    expect(onRaw.pass).toBe(true);
    expect(onRaw.exactByteShare).toBe(1);

    // The helper's own JPEG is not checked here: on detailed products codec
    // error can exceed the per pixel limit, so the live renderers gate every
    // lossy file on this same fidelity check and fall back to PNG.
    const tinted = await fidelityReport(reference, tintInsideMask(result.raw, result.mask, 25), result.mask, {
      kind: "main",
    });
    expect(tinted.pass).toBe(false);
  });

  it("makeSweep reports a placement whose reference matches the raw product bytes", async () => {
    const cut = await texturedCutout();
    const sweep = await makeSweep(cut.png, cut.maskPng, "#D9D9D9", { width: 480, height: 600 });
    const reference = await buildProductReference(await decodeToRgba(cut.png), sweep.placement, sweep.width, sweep.height);
    const onRaw = await fidelityReport(reference, sweep.raw, sweep.mask, { kind: "other" });
    expect(onRaw.pass).toBe(true);
    expect(onRaw.exactByteShare).toBe(1);
    const tinted = await fidelityReport(reference, tintInsideMask(sweep.raw, sweep.mask, 25), sweep.mask, {
      kind: "other",
    });
    expect(tinted.pass).toBe(false);
  });

  it("makeCutoutPng reports the crop it trimmed to", async () => {
    const cut = await texturedCutout();
    const cutout = await makeCutoutPng(cut.png, cut.maskPng);
    expect(cutout.crop).toEqual(boundingBoxOfMask(await decodeMask(cut.maskPng)));
    expect(cutout.crop.width).toBe(cutout.width);
    expect(cutout.crop.height).toBe(cutout.height);
  });

  it("buildProductReference leaves everything outside the placement empty", async () => {
    const cut = await texturedCutout(64);
    const crop = boundingBoxOfMask(cut.mask)!;
    const reference = await buildProductReference(
      cut.rgba,
      { crop, left: 10, top: 5, width: 20, height: 30, kernel: PRODUCT_RESIZE_KERNEL },
      50,
      40,
      { alpha: { mask: cut.mask, mode: "replace" } },
    );
    expect(reference.width).toBe(50);
    expect(reference.height).toBe(40);
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 50; x++) {
        const inside = x >= 10 && x < 30 && y >= 5 && y < 35;
        expect(reference.data[(y * 50 + x) * 4 + 3]).toBe(inside ? 255 : 0);
      }
    }
  });
});

/**
 * Seeded noise product (the worst case for JPEG size) on a gray photo, with
 * its mask, as encoded buffers.
 */
async function noisyProduct(size = 300): Promise<{ source: Buffer; mask: Buffer }> {
  const data = Buffer.alloc(size * size * 4, 0);
  const maskData = Buffer.alloc(size * size, 0);
  let seed = 987654;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % 256;
  };
  const inset = Math.round(size * 0.05);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const inside = x >= inset && x < size - inset && y >= inset && y < size - inset;
      data[o] = inside ? next() : 128;
      data[o + 1] = inside ? next() : 128;
      data[o + 2] = inside ? next() : 128;
      data[o + 3] = 255;
      if (inside) maskData[y * size + x] = 255;
    }
  }
  return {
    source: await sharp(data, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer(),
    mask: await sharp(maskData, { raw: { width: size, height: size, channels: 1 } }).png().toBuffer(),
  };
}

/** A 600 px main spec whose smallest accepted long side is 400. */
function limitSpec(maxBytes?: number): ChannelSpec {
  return { ...smallSpec, width: 600, height: 600, minLongSide: 400, maxBytes };
}

/** Bytes of this raw canvas at the lowest JPEG quality. */
async function bytesAtMinQuality(raw: RawImage): Promise<number> {
  const result = await encodeUnderLimit(raw, 1);
  expect(result.overLimit).toBe(true);
  expect(result.quality).toBe(MIN_JPEG_QUALITY);
  return result.jpeg.length;
}

describe("makeAmazonMain byte limit (Update.md wave 7 item 8)", () => {
  it("flags a file still over the limit at the lowest quality", async () => {
    const product = await noisyProduct();
    const full = await makeAmazonMain(product.source, product.mask, limitSpec());
    const tight = await encodeUnderLimit(full.raw, 1000);
    expect(tight.overLimit).toBe(true);
    expect(tight.jpeg.length).toBeGreaterThan(1000);
    const roomy = await encodeUnderLimit(full.raw, 50_000_000);
    expect(roomy).toMatchObject({ overLimit: false, quality: 90 });
    const unlimited = await encodeUnderLimit(full.raw, undefined);
    expect(unlimited).toMatchObject({ overLimit: false, quality: 90 });
  });

  it("steps the size down toward the spec minimum long side to fit the limit", async () => {
    const product = await noisyProduct();
    const full = await makeAmazonMain(product.source, product.mask, limitSpec());
    expect(full.width).toBe(600);
    const floor = await makeAmazonMain(product.source, product.mask, { ...limitSpec(), width: 400, height: 400 });
    const fullBytes = await bytesAtMinQuality(full.raw);
    const floorBytes = await bytesAtMinQuality(floor.raw);
    expect(floorBytes).toBeLessThan(fullBytes);

    // A limit the full size cannot meet at any quality but the floor size can.
    const maxBytes = Math.floor((fullBytes + floorBytes) / 2);
    const fitted = await makeAmazonMain(product.source, product.mask, limitSpec(maxBytes));
    expect(fitted.jpeg.length).toBeLessThanOrEqual(maxBytes);
    expect(fitted.width).toBeLessThan(600);
    expect(fitted.width).toBeGreaterThanOrEqual(400);
    expect(fitted.height).toBe(fitted.width);
    // Everything else follows the smaller canvas.
    expect(fitted.raw.width).toBe(fitted.width);
    expect(fitted.mask.width).toBe(fitted.width);
    expect(fitted.fillRatio).toBeGreaterThanOrEqual(0.85);
    expect(fitted.fillRatio).toBeLessThanOrEqual(0.9);
    const meta = await sharp(fitted.jpeg).metadata();
    expect(meta.width).toBe(fitted.width);
  });

  it("throws OutputTooLargeError when even the smallest accepted size is too big", async () => {
    const product = await noisyProduct();
    const floor = await makeAmazonMain(product.source, product.mask, { ...limitSpec(), width: 400, height: 400 });
    const floorBytes = await bytesAtMinQuality(floor.raw);
    await expect(makeAmazonMain(product.source, product.mask, limitSpec(floorBytes - 1))).rejects.toBeInstanceOf(
      OutputTooLargeError,
    );
  });

  it("never steps below the spec floor or resizes an exact size spec", () => {
    expect(stepDownSizes(2000, 2000, getSpec("amazon.main"))).toEqual([
      { width: 2000, height: 2000 },
      { width: 1700, height: 1700 },
      { width: 1600, height: 1600 },
    ]);
    expect(stepDownSizes(600, 600, limitSpec())).toEqual([
      { width: 600, height: 600 },
      { width: 510, height: 510 },
      { width: 434, height: 434 },
      { width: 400, height: 400 },
    ]);
    expect(stepDownSizes(1080, 1350, getSpec("meta.feed_4x5"))).toEqual([{ width: 1080, height: 1350 }]);
  });
});
