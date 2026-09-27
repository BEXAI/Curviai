import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { getSpec, type ChannelSpec } from "@curvi/specs";
import { decodeToRgba, maskFromAlpha } from "../raw";
import { boundingBoxOfMask } from "../mask";
import { rectProduct } from "../testutil";
import { makeAmazonMain, makeCutoutPng, makeSweep } from "./whiten";

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
