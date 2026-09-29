import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { getSpec, listSpecs } from "@curvi/specs";
import { ciede2000, rgbToLab } from "../color";
import {
  canvasSizeFor,
  cropWindowFor,
  MAX_SOURCE_UPSCALE,
  originalFitFor,
  originalScale,
  specAcceptsImage,
} from "../output-options";
import { fidelityReport } from "../qc/fidelity";
import { decodeToRgba, encodeJpeg, encodePng, type RawImage, type RawMask } from "../raw";
import { originalFit } from "../seed/templates";
import { TREATMENT_NOTES, treatmentNotes } from "../treatment";
import {
  cropFor,
  detectAlreadyWhite,
  edgeRingMedian,
  iccProfileDescription,
  keptScale,
  makeAlreadyWhite,
  makeOriginalFit,
  sourceFacts,
  SourceTooSmallError,
  type OriginalFitOptions,
  type OriginalRender,
} from "./original";
import { buildProductReferenceFromEncoded } from "./whiten";

const execFileAsync = promisify(execFile);

const PAD: readonly [number, number, number] = [31, 42, 68];
const OPTS: OriginalFitOptions = {
  fit: "auto",
  padRgb: PAD,
  maxUpscale: MAX_SOURCE_UPSCALE,
  maxMegapixels: originalFit.maxMegapixels,
};

/**
 * A photo like a seller's: gradients, seeded noise and a red label with
 * hard edged white text bars, so resampling and codec drift show up.
 */
function photoPixels(width: number, height: number, channels: 3 | 4 = 3): Buffer {
  const data = Buffer.alloc(width * height * channels);
  let seed = 987654321;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 21) - 10;
  };
  const labelLeft = Math.floor(width * 0.35);
  const labelRight = Math.floor(width * 0.65);
  const labelTop = Math.floor(height * 0.3);
  const labelBottom = Math.floor(height * 0.7);
  const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels;
      let r = 40 + (150 * x) / width + noise();
      let g = 60 + (120 * y) / height + noise();
      let b = 170 - (100 * (x + y)) / (width + height) + noise();
      if (x >= labelLeft && x < labelRight && y >= labelTop && y < labelBottom) {
        const bar = Math.floor(((y - labelTop) / (labelBottom - labelTop)) * 9) % 2 === 1;
        [r, g, b] = bar ? [250, 250, 250] : [200, 20, 30];
      }
      data[o] = clampByte(r);
      data[o + 1] = clampByte(g);
      data[o + 2] = clampByte(b);
      if (channels === 4) {
        data[o + 3] = 255;
      }
    }
  }
  return data;
}

async function jpegPhoto(width: number, height: number, quality = 92): Promise<Buffer> {
  return sharp(photoPixels(width, height), { raw: { width, height, channels: 3 } })
    .jpeg({ quality, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

async function rendered(bytes: Buffer, specId: string, opts: Partial<OriginalFitOptions> = {}): Promise<OriginalRender> {
  const result = await makeOriginalFit(bytes, getSpec(specId), { ...OPTS, ...opts });
  if (result.passthrough) {
    throw new Error(`expected a render on ${specId}, got the unchanged file`);
  }
  return result;
}

async function referenceFor(bytes: Buffer, result: OriginalRender): Promise<RawImage> {
  return buildProductReferenceFromEncoded(bytes, result.placement, { width: result.width, height: result.height });
}

/** Mean and max CIEDE2000 between two RGBA buffers over the pixels where mask is 255 (or everywhere). */
function deltaE(a: RawImage, b: RawImage, mask?: RawMask): { mean: number; max: number } {
  let sum = 0;
  let max = 0;
  let n = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    if (mask && mask.data[i] !== 255) continue;
    const o = i * 4;
    const d = ciede2000(rgbToLab(a.data[o], a.data[o + 1], a.data[o + 2]), rgbToLab(b.data[o], b.data[o + 1], b.data[o + 2]));
    sum += d;
    n++;
    if (d > max) max = d;
  }
  return { mean: n === 0 ? 0 : sum / n, max };
}

async function rawOf(pipeline: sharp.Sharp): Promise<RawImage> {
  const { data, info } = await pipeline.toColourspace("srgb").ensureAlpha().raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: 4 };
}

describe("makeOriginalFit: passthrough", () => {
  it("ships a 1500 by 1500 sRGB JPEG on etsy.listing as the stored bytes", async () => {
    const bytes = await jpegPhoto(1500, 1500);
    const result = await makeOriginalFit(bytes, getSpec("etsy.listing"), OPTS);
    expect(result.passthrough).toBeDefined();
    expect(result.raw).toBeUndefined();
    expect(result.passthrough?.bytes.equals(bytes)).toBe(true);
    expect(result.passthrough?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.passthrough?.format).toBe("jpg");
    expect(result.treatment).toMatchObject({ kind: "original_unchanged", scale: 1 });
    expect(treatmentNotes(result.treatment)).toContain(TREATMENT_NOTES.unchangedFile);
  });

  it("passes a file tagged with an sRGB profile, and renders one tagged Display P3", async () => {
    const pixels = photoPixels(1200, 1200);
    const tagged = await sharp(pixels, { raw: { width: 1200, height: 1200, channels: 3 } }).withIccProfile("srgb").jpeg().toBuffer();
    expect((await sourceFacts(tagged)).iccDescription).toBe("sRGB");
    expect((await makeOriginalFit(tagged, getSpec("etsy.listing"), OPTS)).passthrough).toBeDefined();

    const p3 = await sharp(pixels, { raw: { width: 1200, height: 1200, channels: 3 } }).withIccProfile("p3").jpeg({ quality: 95 }).toBuffer();
    const result = await rendered(p3, "etsy.listing");
    expect(result.treatment.colorConverted).toBe(true);
    expect(result.treatment.kind).toBe("original");
    // Matches sharp's own conversion of the same file.
    const own = await rawOf(sharp(p3).withIccProfile("srgb"));
    expect(deltaE(own, result.raw).mean).toBeLessThanOrEqual(1);
  });

  it("renders instead of passing through a file over the byte limit, with metadata or with real alpha", async () => {
    const bytes = await jpegPhoto(1000, 1000);
    const tiny = { ...getSpec("etsy.listing"), maxBytes: 1000 };
    expect((await makeOriginalFit(bytes, tiny, OPTS)).passthrough).toBeUndefined();

    const withGps = await sharp(bytes)
      .withExif({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } })
      .jpeg()
      .toBuffer();
    expect((await sharp(withGps).metadata()).exif).toBeDefined();
    const fromGps = await rendered(withGps, "etsy.listing");
    // No delivered file carries a GPS tag: the render drops every tag.
    const shipped = await encodeJpeg(fromGps.raw);
    expect((await sharp(shipped).metadata()).exif).toBeUndefined();
  });
});

describe("makeOriginalFit: geometry and rule 3", () => {
  it("fits a 4032 by 3024 photo to amazon.secondary at 2000 by 1500, matching the reference inside the mask", async () => {
    const bytes = await jpegPhoto(4032, 3024);
    const result = await rendered(bytes, "amazon.secondary");
    expect([result.width, result.height]).toEqual([2000, 1500]);
    expect(result.treatment).toMatchObject({ kind: "original", sourceWidth: 4032, sourceHeight: 3024 });
    expect(result.treatment.padHex).toBeUndefined();
    expect(treatmentNotes(result.treatment)).toContain(TREATMENT_NOTES.resizedFrom(4032, 3024));
    const reference = await referenceFor(bytes, result);
    const report = await fidelityReport(reference, result.raw, result.mask, { kind: "main", erodePx: 0 });
    expect(report.pass).toBe(true);
    expect(report.exactByteShare).toBe(1);
  });

  it("does not sharpen: against an independent lanczos3 resize the max deltaE is at most 0.5", async () => {
    const bytes = await jpegPhoto(3000, 3000);
    const result = await rendered(bytes, "etsy.listing");
    expect([result.width, result.height]).toEqual([2000, 2000]);
    const independent = await rawOf(sharp(bytes).resize(2000, 2000, { kernel: "lanczos3", fastShrinkOnLoad: false }));
    expect(deltaE(independent, result.raw).max).toBeLessThanOrEqual(0.5);
  });

  it("pads on meta.feed_4x5 with exactly the pad color and an exact photo region", async () => {
    const bytes = await jpegPhoto(1200, 900);
    const result = await rendered(bytes, "meta.feed_4x5", { fit: "pad" });
    expect([result.width, result.height]).toEqual([1080, 1350]);
    expect(result.treatment.padHex).toBe("#1F2A44");
    const { left, top, width, height } = result.placement;
    let wrongMask = 0;
    let wrongPad = 0;
    for (let y = 0; y < result.height; y++) {
      for (let x = 0; x < result.width; x++) {
        const inside = x >= left && x < left + width && y >= top && y < top + height;
        const i = y * result.width + x;
        if (result.mask.data[i] !== (inside ? 255 : 0)) wrongMask++;
        const o = i * 4;
        if (!inside && (result.raw.data[o] !== PAD[0] || result.raw.data[o + 1] !== PAD[1] || result.raw.data[o + 2] !== PAD[2])) {
          wrongPad++;
        }
      }
    }
    expect([wrongMask, wrongPad]).toEqual([0, 0]);
    const reference = await referenceFor(bytes, result);
    const report = await fidelityReport(reference, result.raw, result.mask, { kind: "main", erodePx: 0 });
    expect(report.exactByteShare).toBe(1);
  });

  it("keeps the photo inside the safe zone on meta.story_9x16, even with auto", async () => {
    const bytes = await jpegPhoto(900, 1600);
    const spec = getSpec("meta.story_9x16");
    const result = await rendered(bytes, spec.id);
    const zone = spec.safeZone ?? { top: 0, bottom: 0 };
    expect(result.placement.top).toBeGreaterThanOrEqual(zone.top);
    expect(result.placement.top + result.placement.height).toBeLessThanOrEqual(result.height - zone.bottom);
  });

  it("keeps its own shape on ebay.listing even with pad", async () => {
    const bytes = await jpegPhoto(1200, 800);
    const result = await makeOriginalFit(bytes, getSpec("ebay.listing"), { ...OPTS, fit: "pad" });
    expect([result.width, result.height]).toEqual([1200, 800]);
    expect(result.treatment.padHex).toBeUndefined();
  });

  it("enlarges a small photo up to 1.5 and refuses one that needs more", async () => {
    const enlarged = await rendered(await jpegPhoto(1100, 800), "amazon.secondary");
    expect(enlarged.width).toBe(1600);
    expect(enlarged.treatment.scale).toBeCloseTo(1600 / 1100, 6);
    expect(treatmentNotes(enlarged.treatment)).toContain(TREATMENT_NOTES.enlarged(1600 / 1100));
    await expect(makeOriginalFit(await jpegPhoto(1000, 800), getSpec("amazon.secondary"), OPTS)).rejects.toBeInstanceOf(
      SourceTooSmallError,
    );
  });

  it("never scales above the cap and agrees with the planner's originalScale on every spec that takes a kept photo", () => {
    const sizes = [
      [400, 300],
      [1067, 800],
      [1100, 1100],
      [3000, 400],
      [4032, 3024],
      [6000, 4000],
      [10328, 7744],
    ] as const;
    for (const spec of listSpecs().filter((s) => specAcceptsImage(s, "original"))) {
      for (const fit of ["auto", "pad"] as const) {
        for (const [w, h] of sizes) {
          const mine = keptScale({ width: w, height: h }, spec, originalFitFor(spec, { fit }), {
            maxUpscale: MAX_SOURCE_UPSCALE,
            maxMegapixels: originalFit.maxMegapixels,
          });
          const planner = originalScale({ width: w, height: h }, spec, { fit });
          expect(mine.scale).toBeLessThanOrEqual(MAX_SOURCE_UPSCALE);
          expect(mine.scale).toBe(planner.scale);
          expect(mine.skip).toBe(planner.skip);
          // The renderer rounds down where rounding would pass the megapixel cap.
          expect(Math.abs(mine.width - planner.width)).toBeLessThanOrEqual(1);
          expect(Math.abs(mine.height - planner.height)).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("raises a 3000 by 400 panorama to Google's 500 minimum height", () => {
    const scaled = keptScale({ width: 3000, height: 400 }, getSpec("google.merchant.lifestyle"), "auto", {
      maxUpscale: MAX_SOURCE_UPSCALE,
      maxMegapixels: originalFit.maxMegapixels,
    });
    expect(scaled.skip).toBeUndefined();
    expect(scaled.height).toBe(500);
  });

  it("never enlarges with Never enlarge my photo (cap 1.0)", () => {
    const spec = getSpec("etsy.listing");
    const small = { width: 1500, height: 1500 };
    const capped = keptScale(small, spec, "auto", { maxUpscale: 1, maxMegapixels: originalFit.maxMegapixels });
    const planned = originalScale(small, spec, { fit: "auto", enlarge: false });
    expect(capped.scale).toBeLessThanOrEqual(1);
    expect(capped.skip).toBe(planned.skip);
    expect(planned.scale).toBeLessThanOrEqual(1);
    // Within the cap nothing changes: a photo that already fits stays at 1.
    const fits = originalScale({ width: 2000, height: 2000 }, spec, { fit: "auto", enlarge: false });
    expect(fits.skip).toBeUndefined();
    expect(fits.scale).toBe(1);
  });
});

describe("makeOriginalFit: trim to the channel's shape (P1 crop)", () => {
  const W = 1600;
  const H = 1200;
  // The product: the red label in photoPixels, 35% to 65% across, 30% to 70% down.
  const BOX = { left: Math.floor(W * 0.35), top: Math.floor(H * 0.3), width: Math.floor(W * 0.3), height: Math.floor(H * 0.4) };

  it("trims to meta.feed_4x5 around the product box and proves every pixel", async () => {
    const bytes = await jpegPhoto(W, H);
    const result = await rendered(bytes, "meta.feed_4x5", { fit: "crop", productBox: BOX });
    expect([result.width, result.height]).toEqual([1080, 1350]);
    const { crop } = result.placement;
    expect(crop.left).toBeLessThanOrEqual(BOX.left);
    expect(crop.top).toBeLessThanOrEqual(BOX.top);
    expect(crop.left + crop.width).toBeGreaterThanOrEqual(BOX.left + BOX.width);
    expect(crop.top + crop.height).toBeGreaterThanOrEqual(BOX.top + BOX.height);
    expect(result.treatment.cropped).toBe(true);
    expect(result.treatment.padHex).toBeUndefined();
    expect(treatmentNotes(result.treatment)).toContain(TREATMENT_NOTES.cropped);
    // No added space: the mask covers the whole canvas.
    expect(result.mask.data.every((v) => v === 255)).toBe(true);
    const exact = await fidelityReport(await referenceFor(bytes, result), result.raw, result.mask, { kind: "main", exact: true });
    expect(exact.pass).toBe(true);
  });

  it("keeps the product inside meta.story_9x16's safe zone", async () => {
    // Large enough that the 9:16 window reaches 1080 by 1920 within the cap.
    const bytes = await jpegPhoto(2400, 1800);
    const box = { left: 840, top: 540, width: 720, height: 720 };
    const spec = getSpec("meta.story_9x16");
    const result = await rendered(bytes, spec.id, { fit: "crop", productBox: box });
    expect(result.treatment.cropped).toBe(true);
    const scale = result.width / result.placement.crop.width;
    const top = (box.top - result.placement.crop.top) * scale;
    const bottom = (box.top + box.height - result.placement.crop.top) * scale;
    expect(top).toBeGreaterThanOrEqual((spec.safeZone?.top ?? 0) - 1);
    expect(bottom).toBeLessThanOrEqual(result.height - (spec.safeZone?.bottom ?? 0) + 1);
  });

  it("falls back to added space, with a note, when there is no product box", async () => {
    const result = await rendered(await jpegPhoto(W, H), "meta.feed_4x5", { fit: "crop" });
    expect(result.treatment.cropped).toBeUndefined();
    expect(result.treatment.cropFallback).toBe(true);
    expect(result.treatment.padHex).toBe("#1F2A44");
    expect(treatmentNotes(result.treatment)).toContain(TREATMENT_NOTES.cropFallback);
  });

  it("falls back to the photo's own shape on a spec that refuses borders", async () => {
    // A box as wide as the photo cannot fit a square window of a 4:3 photo.
    const wide = { left: 0, top: 400, width: W, height: 300 };
    const result = await makeOriginalFit(await jpegPhoto(W, H), getSpec("ebay.listing"), { ...OPTS, fit: "crop", productBox: wide });
    expect(result.width / result.height).toBeCloseTo(W / H, 2);
    expect(result.treatment.cropFallback).toBe(true);
    expect(result.treatment.padHex).toBeUndefined();
  });

  it("falls back when the window would need enlarging past the cap", () => {
    const fit = cropFor({ width: 900, height: 900 }, getSpec("meta.story_9x16"), {
      productBox: { left: 300, top: 300, width: 300, height: 300 },
      maxUpscale: 1,
      maxMegapixels: originalFit.maxMegapixels,
    });
    expect(fit).toBeNull();
  });

  it("property: the window always holds the box plus margin, in the spec's shape, or there is none", () => {
    let seed = 20260929;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const specs = listSpecs().filter((s) => specAcceptsImage(s, "original"));
    let windows = 0;
    for (let i = 0; i < 3000; i++) {
      const spec = specs[Math.floor(rand() * specs.length)];
      const photo = { width: 200 + Math.floor(rand() * 5000), height: 200 + Math.floor(rand() * 5000) };
      const bw = 1 + Math.floor(rand() * photo.width);
      const bh = 1 + Math.floor(rand() * photo.height);
      const box = {
        left: Math.floor(rand() * (photo.width - bw + 1)),
        top: Math.floor(rand() * (photo.height - bh + 1)),
        width: bw,
        height: bh,
      };
      const win = cropWindowFor(photo, box, spec);
      if (!win) continue;
      windows++;
      const margin = originalFit.cropMarginShare * Math.max(bw, bh);
      const needLeft = Math.max(0, box.left - margin);
      const needTop = Math.max(0, box.top - margin);
      const needRight = Math.min(photo.width, box.left + bw + margin);
      const needBottom = Math.min(photo.height, box.top + bh + margin);
      expect(win.left).toBeGreaterThanOrEqual(0);
      expect(win.top).toBeGreaterThanOrEqual(0);
      expect(win.left + win.width).toBeLessThanOrEqual(photo.width);
      expect(win.top + win.height).toBeLessThanOrEqual(photo.height);
      expect(win.left).toBeLessThanOrEqual(needLeft);
      expect(win.top).toBeLessThanOrEqual(needTop);
      expect(win.left + win.width).toBeGreaterThanOrEqual(needRight);
      expect(win.top + win.height).toBeGreaterThanOrEqual(needBottom);
      const canvas = canvasSizeFor(spec);
      expect(Math.abs(win.width / win.height - canvas.width / canvas.height)).toBeLessThan(0.02);
      if (spec.safeZone) {
        const s = canvas.height / win.height;
        expect((needTop - win.top) * s).toBeGreaterThanOrEqual(spec.safeZone.top - 2);
        expect((win.top + win.height - needBottom) * s).toBeGreaterThanOrEqual(spec.safeZone.bottom - 2);
      }
    }
    expect(windows).toBeGreaterThan(300);
  });
});

describe("makeOriginalFit: match my photo's edges (P1)", () => {
  /** A photo with a flat sage border two pixels wide and one stray pixel. */
  async function framedPhoto(width: number, height: number): Promise<Buffer> {
    const data = photoPixels(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x < 4 || y < 4 || x >= width - 4 || y >= height - 4) {
          const o = (y * width + x) * 3;
          data[o] = 120;
          data[o + 1] = 140;
          data[o + 2] = 110;
        }
      }
    }
    data[0] = 255;
    return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
  }

  it("fills the added space with the median color of the photo's outer ring", async () => {
    const result = await rendered(await framedPhoto(1000, 1000), "meta.feed_4x5", { fit: "pad", edgeMatch: true });
    expect(result.treatment.padHex).toBe("#788C6E");
    const { data, width } = result.raw;
    // The first row is added space, one flat color.
    for (let x = 0; x < width; x += 97) {
      expect([data[x * 4], data[x * 4 + 1], data[x * 4 + 2]]).toEqual([120, 140, 110]);
    }
  });

  it("edgeRingMedian reads only the ring and ignores clear pixels", () => {
    const w = 6;
    const h = 6;
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba.set([10, 20, 30, 255], i * 4);
    }
    // The center is never read; a clear ring pixel is skipped.
    rgba.set([250, 250, 250, 255], (3 * w + 3) * 4);
    rgba.set([250, 250, 250, 0], 0);
    expect(edgeRingMedian(rgba, w, h, 2)).toEqual([10, 20, 30]);
    expect(edgeRingMedian(Buffer.alloc(w * h * 4), w, h, 2)).toBeNull();
  });
});

describe("makeOriginalFit: color and format fixtures", () => {
  const W = 1200;
  const H = 900;

  it("converts a CMYK JPEG like sharp does", async () => {
    const cmyk = await sharp(photoPixels(W, H), { raw: { width: W, height: H, channels: 3 } })
      .toColourspace("cmyk")
      .withIccProfile("cmyk")
      .jpeg({ quality: 95 })
      .toBuffer();
    expect((await sharp(cmyk).metadata()).space).toBe("cmyk");
    const result = await rendered(cmyk, "etsy.listing");
    expect(result.treatment.colorConverted).toBe(true);
    const own = await rawOf(sharp(cmyk).withIccProfile("srgb"));
    expect(deltaE(own, result.raw).mean).toBeLessThanOrEqual(1);
    const reference = await referenceFor(cmyk, result);
    expect((await fidelityReport(reference, result.raw, result.mask, { kind: "main", erodePx: 0 })).exactByteShare).toBe(1);
  });

  it("brings a 16 bit PNG with an embedded Display P3 profile to the right sRGB values", async () => {
    const pixels = photoPixels(W, H);
    const source: RawImage = await rawOf(sharp(pixels, { raw: { width: W, height: H, channels: 3 } }));
    const p16 = await sharp(pixels, { raw: { width: W, height: H, channels: 3 } })
      .toColourspace("rgb16")
      .withIccProfile("p3")
      .png()
      .toBuffer();
    const meta = await sharp(p16).metadata();
    expect([meta.depth, Boolean(meta.icc)]).toEqual(["ushort", true]);
    const result = await rendered(p16, "etsy.listing");
    expect(result.treatment.colorConverted).toBe(true);
    expect(result.preferPng).toBe(true);
    // Untagged P3 values would sit several deltaE away from the photo.
    expect(deltaE(source, result.raw).mean).toBeLessThanOrEqual(1);
    const reference = await referenceFor(p16, result);
    expect((await fidelityReport(reference, result.raw, result.mask, { kind: "main", erodePx: 0 })).exactByteShare).toBe(1);

    const untagged = await sharp(pixels, { raw: { width: W, height: H, channels: 3 } }).toColourspace("rgb16").png().toBuffer();
    const fromUntagged = await rendered(untagged, "etsy.listing");
    expect(deltaE(source, fromUntagged.raw).mean).toBeLessThanOrEqual(1);
  });

  it("fills transparent areas of an alpha PNG with the resolved color and uses the alpha as the mask", async () => {
    const rgba = photoPixels(W, H, 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < 200; x++) rgba[(y * W + x) * 4 + 3] = 0;
    }
    const png = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
    const result = await rendered(png, "etsy.listing");
    expect(result.treatment.alphaFilledHex).toBe("#1F2A44");
    expect(treatmentNotes(result.treatment)).toContain(TREATMENT_NOTES.alphaFilled("#1F2A44"));
    const clear = (10 * W + 10) * 4;
    expect([...result.raw.data.subarray(clear, clear + 3)]).toEqual([...PAD]);
    expect(result.mask.data[10 * W + 10]).toBe(0);
    expect(result.mask.data[10 * W + 600]).toBe(255);

    // A PNG whose alpha is fully opaque still ships unchanged.
    const opaque = await sharp(photoPixels(W, H, 4), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
    expect((await makeOriginalFit(opaque, getSpec("etsy.listing"), OPTS)).passthrough).toBeDefined();
  });

  it("renders a grayscale JPEG instead of passing it through", async () => {
    const gray = await sharp(photoPixels(W, H), { raw: { width: W, height: H, channels: 3 } }).toColourspace("b-w").jpeg().toBuffer();
    expect((await sharp(gray).metadata()).channels).toBe(1);
    const result = await rendered(gray, "etsy.listing");
    const o = (400 * W + 400) * 4;
    expect(result.raw.data[o]).toBe(result.raw.data[o + 1]);
    expect(result.raw.data[o + 1]).toBe(result.raw.data[o + 2]);
  });

  it("turns an EXIF rotated upload upright and says the stored copy was turned at upload", async () => {
    const rotated = await sharp(await jpegPhoto(W, H)).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const result = await rendered(rotated, "etsy.listing", { reencodedAtUpload: true });
    expect([result.width, result.height]).toEqual([H, W]);
    expect(treatmentNotes(result.treatment)).toContain(TREATMENT_NOTES.turnedUpright);
    const reference = await referenceFor(rotated, result);
    expect((await fidelityReport(reference, result.raw, result.mask, { kind: "main", erodePx: 0 })).exactByteShare).toBe(1);
  });

  it("reads ICC descriptions from v4 mluc and v2 desc profiles", async () => {
    const base = sharp(photoPixels(64, 48), { raw: { width: 64, height: 48, channels: 3 } });
    const srgb = (await sharp(await base.clone().withIccProfile("srgb").jpeg().toBuffer()).metadata()).icc;
    const p3 = (await sharp(await base.clone().withIccProfile("p3").jpeg().toBuffer()).metadata()).icc;
    const cmyk = (await sharp(await base.clone().toColourspace("cmyk").withIccProfile("cmyk").jpeg().toBuffer()).metadata()).icc;
    expect(iccProfileDescription(srgb as Buffer)).toBe("sRGB");
    expect(iccProfileDescription(p3 as Buffer)).toBe("sP3C");
    expect(iccProfileDescription(cmyk as Buffer)).toBe("Chemical proof");
    expect(iccProfileDescription(Buffer.alloc(40))).toBeNull();
  });
});

describe("makeOriginalFit: the fidelity gate catches drift", () => {
  it("fails a render that was sharpened, brightened by 2 percent or shifted by 1 px", async () => {
    const bytes = await jpegPhoto(2400, 1800);
    const result = await rendered(bytes, "amazon.secondary");
    const reference = await referenceFor(bytes, result);
    const { width, height } = result;
    const asRaw = async (p: sharp.Sharp): Promise<RawImage> => rawOf(p);
    const input = sharp(result.raw.data, { raw: { width, height, channels: 4 } });
    const sharpened = await asRaw(input.clone().sharpen());
    const brighter = await asRaw(input.clone().modulate({ brightness: 1.02 }));
    const shifted = Buffer.from(result.raw.data);
    shifted.copy(shifted, 4, 0, shifted.length - 4);
    const opts = { kind: "main" as const, erodePx: 3, exact: true };
    expect((await fidelityReport(reference, result.raw, result.mask, opts)).pass).toBe(true);
    const rowOnly: boolean[] = [];
    for (const mutated of [sharpened, brighter, { ...result.raw, data: shifted }]) {
      expect((await fidelityReport(reference, mutated, result.mask, opts)).pass).toBe(false);
      rowOnly.push((await fidelityReport(reference, mutated, result.mask, { kind: "main", erodePx: 3 })).pass);
    }
    // The deltaE row alone catches the sharpen and the shift; a 2 percent
    // brightness change stays under it, which is why kept renders are proven
    // exact before encoding.
    expect(rowOnly).toEqual([false, true, false]);
  });

  it("passes a red label photo through the encode ladder", async () => {
    const bytes = await jpegPhoto(2400, 1800);
    const result = await rendered(bytes, "amazon.secondary");
    const reference = await referenceFor(bytes, result);
    let passed: string | null = null;
    for (const quality of [90, 95, 98, 100]) {
      const shipped = await decodeToRgba(await encodeJpeg(result.raw, quality));
      if ((await fidelityReport(reference, shipped, result.mask, { kind: "main", erodePx: 3 })).pass) {
        passed = `jpg ${quality}`;
        break;
      }
    }
    if (!passed) {
      const shipped = await decodeToRgba(await encodePng(result.raw));
      passed = (await fidelityReport(reference, shipped, result.mask, { kind: "main", erodePx: 3 })).pass ? "png" : null;
    }
    expect(passed).not.toBeNull();
  });
});

describe("already white photos", () => {
  /** A product (textured box) on pure 255 white, with its mask at half size like a preflight cutout. */
  async function studioPhoto(width: number, height: number, box: { left: number; top: number; width: number; height: number }) {
    const pixels = photoPixels(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height) continue;
        pixels.fill(255, (y * width + x) * 3, (y * width + x) * 3 + 3);
      }
    }
    const bytes = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const mw = width / 2;
    const mh = height / 2;
    const maskData = Buffer.alloc(mw * mh, 0);
    for (let y = Math.floor(box.top / 2); y < Math.ceil((box.top + box.height) / 2); y++) {
      for (let x = Math.floor(box.left / 2); x < Math.ceil((box.left + box.width) / 2); x++) maskData[y * mw + x] = 255;
    }
    return { bytes, mask: { data: maskData, width: mw, height: mh } };
  }

  it("detects a studio photo on pure white and makes the Amazon main by crop, resize and white pad", async () => {
    const { bytes, mask } = await studioPhoto(2400, 1800, { left: 700, top: 300, width: 1000, height: 1200 });
    const spec = getSpec("amazon.main");
    expect((await detectAlreadyWhite(bytes, mask, spec, { edgeMarginPx: 2 })).alreadyWhite).toBe(true);
    const made = await makeAlreadyWhite(bytes, mask, spec, { maxUpscale: MAX_SOURCE_UPSCALE, edgeMarginPx: 2 });
    if (!made.ok) throw new Error(made.reason);
    expect([made.width, made.height]).toEqual([2000, 2000]);
    expect(made.fillRatio).toBeGreaterThanOrEqual(0.85);
    expect(made.fillRatio).toBeLessThanOrEqual(0.9);
    expect(made.treatment).toMatchObject({ kind: "original", alreadyWhite: true });
    expect(treatmentNotes(made.treatment)[0]).toBe(TREATMENT_NOTES.alreadyWhite);
    // Rule 3: the placed rectangle matches the reference built from the same bytes.
    const reference = await buildProductReferenceFromEncoded(bytes, made.placement, { width: made.width, height: made.height });
    const report = await fidelityReport(reference, made.raw, made.mask, { kind: "main", erodePx: 0 });
    expect(report.exactByteShare).toBe(1);
  });

  it("refuses a photo on off white, and reports a fill it cannot reach", async () => {
    const spec = getSpec("amazon.main");
    const { bytes, mask } = await studioPhoto(2400, 1800, { left: 700, top: 300, width: 1000, height: 1200 });
    const gray = await sharp(bytes).linear(0.99, 0).png().toBuffer();
    expect(await detectAlreadyWhite(gray, mask, spec, { edgeMarginPx: 2 })).toMatchObject({
      alreadyWhite: false,
      reason: "background_not_white",
    });
    expect((await detectAlreadyWhite(bytes, mask, getSpec("etsy.listing"), { edgeMarginPx: 2 })).reason).toBe("not_white_required");

    const small = await studioPhoto(1200, 1200, { left: 500, top: 500, width: 200, height: 200 });
    const made = await makeAlreadyWhite(small.bytes, small.mask, spec, { maxUpscale: MAX_SOURCE_UPSCALE, edgeMarginPx: 2 });
    expect(made).toEqual({ ok: false, reason: "fill_unreachable" });
  });
});

describe("memory on an 80 MP photo", () => {
  it("ships at most 16 MP on google.merchant.lifestyle", async () => {
    const bytes = await sharp({ create: { width: 10328, height: 7744, channels: 3, background: { r: 120, g: 90, b: 60 } } })
      .jpeg()
      .toBuffer();
    const result = await rendered(bytes, "google.merchant.lifestyle");
    expect(result.width * result.height).toBeLessThanOrEqual(originalFit.maxMegapixels * 1_000_000);
  });

  // Runs in its own process so the peak is this render's alone. Set
  // CURVI_RSS_TEST=1 to run it; it takes several seconds.
  it.runIf(process.env.CURVI_RSS_TEST === "1")(
    "keeps peak RSS under the worker budget",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "curvi-rss-"));
      const here = path.dirname(fileURLToPath(import.meta.url));
      const script = path.join(dir, "rss.mts");
      const photo = path.join(dir, "photo.jpg");
      // The fixture is made here, so its own peak never counts.
      await sharp({
        create: { width: 10328, height: 7744, channels: 3, background: "#000000", noise: { type: "gaussian", mean: 128, sigma: 40 } },
      })
        .jpeg({ quality: 90 })
        .toFile(photo);
      const resolve = createRequire(import.meta.url).resolve;
      await writeFile(
        script,
        `import { readFile } from "node:fs/promises";
import sharp from ${JSON.stringify(resolve("sharp"))};
import { getSpec } from ${JSON.stringify(resolve("@curvi/specs"))};
import { makeOriginalFit } from ${JSON.stringify(path.join(here, "original.ts"))};
import { buildProductReferenceFromEncoded } from ${JSON.stringify(path.join(here, "whiten.ts"))};
// As on Render: no operation cache, one libvips thread (glibc without jemalloc).
sharp.cache(false);
sharp.concurrency(1);
const bytes = await readFile(${JSON.stringify(photo)});
const before = process.resourceUsage().maxRSS;
const started = Date.now();
const result = await makeOriginalFit(bytes, getSpec("google.merchant.lifestyle"), { fit: "auto", padRgb: [255, 255, 255], maxUpscale: 1.5, maxMegapixels: 16 });
if (result.passthrough) throw new Error("expected a render");
const reference = await buildProductReferenceFromEncoded(bytes, result.placement, { width: result.width, height: result.height });
console.log(JSON.stringify({ before: before / 1024, peak: process.resourceUsage().maxRSS / 1024, ms: Date.now() - started, bytes: bytes.length, out: [result.width, result.height], ref: reference.width }));
`,
      );
      try {
        const { stdout } = await execFileAsync("npx", ["tsx", script], { cwd: path.join(here, "..", ".."), maxBuffer: 1 << 20 });
        const facts = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as { peak: number; ms: number };
        console.log(`80 MP render: ${stdout.trim()}`);
        expect(facts.peak).toBeLessThan(RSS_LIMIT_MB);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    300_000,
  );
});

/** The 512 MB worker budget less headroom for the runner's own heap. */
const RSS_LIMIT_MB = 448;
