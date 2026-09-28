/**
 * Deterministic exports built from the user's photo and its cutout mask: the
 * Amazon style white main image, transparent cutout PNG and colored sweep.
 * No generative model touches these pixels (CURVI_BUILD_PLAN.md section 5.7).
 */
import sharp from "sharp";
import type { ChannelSpec } from "@curvi/specs";
import { hexToRgb } from "../color";
import { boundingBoxOfMask, nonZeroMask, type BBox } from "../mask";
import { decodeMask, decodeToRgba, type RawImage, type RawMask } from "../raw";

/** Resize kernel every deterministic helper scales the product with. */
export const PRODUCT_RESIZE_KERNEL = "lanczos3" as const;

/**
 * Where a helper put the product: the box it cropped from the source cutout,
 * and the rectangle on the output canvas that crop was scaled into (with
 * PRODUCT_RESIZE_KERNEL). buildProductReference rebuilds the product pixels
 * from this alone, so rule 3 checks never trust the compositing code.
 */
export interface ProductPlacement {
  /** Crop box in source (cutout) pixel coordinates. */
  crop: BBox;
  /** Left edge of the scaled crop on the output canvas. */
  left: number;
  /** Top edge of the scaled crop on the output canvas. */
  top: number;
  /** Scaled crop width on the output canvas. */
  width: number;
  /** Scaled crop height on the output canvas. */
  height: number;
  kernel: typeof PRODUCT_RESIZE_KERNEL;
}

export interface WhitenResult {
  /** Final encoded JPEG, quality stepped down until under spec.maxBytes. */
  jpeg: Buffer;
  /** Pre encode raw RGBA with the background forced to pure white. */
  raw: RawImage;
  /** Binary product mask at output scale and position (255 = product). */
  mask: RawMask;
  width: number;
  height: number;
  /** Product bounding box longest side over canvas longest side. */
  fillRatio: number;
  jpegQuality: number;
  /** Crop box and canvas rectangle the product was placed at. */
  placement: ProductPlacement;
}

const DEFAULT_FILL_TARGET = 0.875;

/**
 * Build a channel compliant white background main image:
 * force every pixel outside the mask to pure 255 white, trim to the product
 * bounding box, pad so the product longest side hits the spec fill target,
 * resize with lanczos3 and export an sRGB JPEG at quality 90 under maxBytes.
 */
export async function makeAmazonMain(
  sourceBuffer: Buffer,
  maskBuffer: Buffer,
  spec: ChannelSpec,
): Promise<WhitenResult> {
  const source = await decodeToRgba(sourceBuffer);
  const mask = await decodeMask(maskBuffer);
  assertSameSize(source, mask);

  const bbox = boundingBoxOfMask(mask);
  if (!bbox) {
    throw new Error("Mask is empty, cannot build a main image");
  }

  const canvasW = spec.width ?? 2000;
  const canvasH = spec.height ?? canvasW;
  const canvasLong = Math.max(canvasW, canvasH);
  const fillTarget = spec.fill
    ? clamp(DEFAULT_FILL_TARGET, spec.fill.min, spec.fill.max)
    : DEFAULT_FILL_TARGET;

  // Scale so the product longest side hits the fill target, but never overflow
  // either canvas axis.
  const bboxLong = Math.max(bbox.width, bbox.height);
  const scale = Math.min(
    (fillTarget * canvasLong) / bboxLong,
    (canvasW * 0.98) / bbox.width,
    (canvasH * 0.98) / bbox.height,
  );
  const targetW = Math.max(1, Math.round(bbox.width * scale));
  const targetH = Math.max(1, Math.round(bbox.height * scale));

  // Crop image and mask to the product bounding box, then resize both with
  // lanczos3. The mask picks up anti aliased edges that blend the product into
  // the white background smoothly.
  const region = { left: bbox.left, top: bbox.top, width: bbox.width, height: bbox.height };
  const productCrop = await sharp(source.data, {
    raw: { width: source.width, height: source.height, channels: 4 },
  })
    .extract(region)
    .resize(targetW, targetH, { fit: "fill", kernel: PRODUCT_RESIZE_KERNEL })
    .raw()
    .toBuffer();
  const maskCrop = await sharp(mask.data, {
    raw: { width: mask.width, height: mask.height, channels: 1 },
  })
    .extract(region)
    .resize(targetW, targetH, { fit: "fill", kernel: PRODUCT_RESIZE_KERNEL })
    .toColourspace("b-w")
    .raw()
    .toBuffer();

  // Manual composite over pure white so the background is white by
  // construction, not by trusting a codec or a blend mode.
  const outData = Buffer.alloc(canvasW * canvasH * 4, 255);
  const outMaskData = Buffer.alloc(canvasW * canvasH, 0);
  const offsetX = Math.floor((canvasW - targetW) / 2);
  const offsetY = Math.floor((canvasH - targetH) / 2);
  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      const m = maskCrop[y * targetW + x];
      if (m === 0) {
        continue;
      }
      const src = (y * targetW + x) * 4;
      const dst = ((y + offsetY) * canvasW + (x + offsetX)) * 4;
      if (m === 255) {
        outData[dst] = productCrop[src];
        outData[dst + 1] = productCrop[src + 1];
        outData[dst + 2] = productCrop[src + 2];
      } else {
        outData[dst] = Math.round((m * productCrop[src] + (255 - m) * 255) / 255);
        outData[dst + 1] = Math.round((m * productCrop[src + 1] + (255 - m) * 255) / 255);
        outData[dst + 2] = Math.round((m * productCrop[src + 2] + (255 - m) * 255) / 255);
      }
      outMaskData[(y + offsetY) * canvasW + (x + offsetX)] = 255;
    }
  }

  const raw: RawImage = { data: outData, width: canvasW, height: canvasH, channels: 4 };
  const outMask: RawMask = { data: outMaskData, width: canvasW, height: canvasH };
  const { jpeg, quality } = await encodeUnderLimit(raw, spec.maxBytes ?? 10_000_000);

  return {
    jpeg,
    raw,
    mask: outMask,
    width: canvasW,
    height: canvasH,
    fillRatio: Math.max(targetW, targetH) / canvasLong,
    jpegQuality: quality,
    placement: {
      crop: region,
      left: offsetX,
      top: offsetY,
      width: targetW,
      height: targetH,
      kernel: PRODUCT_RESIZE_KERNEL,
    },
  };
}

export interface CutoutResult {
  png: Buffer;
  width: number;
  height: number;
  /** Source box the PNG was trimmed to; its alpha is the source mask. */
  crop: BBox;
}

/** Transparent PNG cutout trimmed to the product bounding box. */
export async function makeCutoutPng(sourceBuffer: Buffer, maskBuffer: Buffer): Promise<CutoutResult> {
  const source = await decodeToRgba(sourceBuffer);
  const mask = await decodeMask(maskBuffer);
  assertSameSize(source, mask);
  const bbox = boundingBoxOfMask(mask);
  if (!bbox) {
    throw new Error("Mask is empty, cannot build a cutout");
  }

  const rgba = Buffer.from(source.data);
  for (let i = 0; i < mask.data.length; i++) {
    rgba[i * 4 + 3] = mask.data[i];
  }
  const crop = { left: bbox.left, top: bbox.top, width: bbox.width, height: bbox.height };
  const png = await sharp(rgba, {
    raw: { width: source.width, height: source.height, channels: 4 },
  })
    .extract(crop)
    .png()
    .toBuffer();
  return { png, width: bbox.width, height: bbox.height, crop };
}

export interface SweepOptions {
  width?: number;
  height?: number;
  /** Product longest side over canvas longest side. */
  fill?: number;
  jpegQuality?: number;
}

export interface SweepResult {
  jpeg: Buffer;
  raw: RawImage;
  mask: RawMask;
  width: number;
  height: number;
  /** Crop box and canvas rectangle the product was placed at. */
  placement: ProductPlacement;
}

/**
 * Studio sweep: a subtle vertical gradient of bgColor (lighter at the top),
 * a soft contact shadow and the untouched product pixels composited on top.
 */
export async function makeSweep(
  sourceBuffer: Buffer,
  maskBuffer: Buffer,
  bgColor: string,
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const source = await decodeToRgba(sourceBuffer);
  const mask = await decodeMask(maskBuffer);
  assertSameSize(source, mask);
  const bbox = boundingBoxOfMask(mask);
  if (!bbox) {
    throw new Error("Mask is empty, cannot build a sweep");
  }

  const canvasW = opts.width ?? 2000;
  const canvasH = opts.height ?? canvasW;
  const fill = opts.fill ?? 0.8;
  const { r, g, b } = hexToRgb(bgColor);

  // Vertical gradient background, +6 percent at the top to -6 percent at the bottom.
  const outData = Buffer.alloc(canvasW * canvasH * 4);
  for (let y = 0; y < canvasH; y++) {
    const factor = 1.06 - (0.12 * y) / Math.max(1, canvasH - 1);
    const rr = clampByte(r * factor);
    const gg = clampByte(g * factor);
    const bb = clampByte(b * factor);
    for (let x = 0; x < canvasW; x++) {
      const o = (y * canvasW + x) * 4;
      outData[o] = rr;
      outData[o + 1] = gg;
      outData[o + 2] = bb;
      outData[o + 3] = 255;
    }
  }

  const bboxLong = Math.max(bbox.width, bbox.height);
  const canvasLong = Math.max(canvasW, canvasH);
  const scale = Math.min(
    (fill * canvasLong) / bboxLong,
    (canvasW * 0.95) / bbox.width,
    (canvasH * 0.85) / bbox.height,
  );
  const targetW = Math.max(1, Math.round(bbox.width * scale));
  const targetH = Math.max(1, Math.round(bbox.height * scale));
  const region = { left: bbox.left, top: bbox.top, width: bbox.width, height: bbox.height };
  const productCrop = await sharp(source.data, {
    raw: { width: source.width, height: source.height, channels: 4 },
  })
    .extract(region)
    .resize(targetW, targetH, { fit: "fill", kernel: PRODUCT_RESIZE_KERNEL })
    .raw()
    .toBuffer();
  const maskCrop = await sharp(mask.data, {
    raw: { width: mask.width, height: mask.height, channels: 1 },
  })
    .extract(region)
    .resize(targetW, targetH, { fit: "fill", kernel: PRODUCT_RESIZE_KERNEL })
    .toColourspace("b-w")
    .raw()
    .toBuffer();

  const offsetX = Math.floor((canvasW - targetW) / 2);
  const offsetY = Math.floor((canvasH - targetH) * 0.6);

  // Soft elliptical contact shadow under the product.
  drawContactShadow(outData, canvasW, canvasH, {
    cx: offsetX + targetW / 2,
    cy: offsetY + targetH - 2,
    rx: targetW * 0.45,
    ry: Math.max(6, targetH * 0.05),
    strength: 0.3,
  });

  const outMaskData = Buffer.alloc(canvasW * canvasH, 0);
  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      const m = maskCrop[y * targetW + x];
      if (m === 0) {
        continue;
      }
      const src = (y * targetW + x) * 4;
      const dst = ((y + offsetY) * canvasW + (x + offsetX)) * 4;
      for (let c = 0; c < 3; c++) {
        outData[dst + c] =
          m === 255
            ? productCrop[src + c]
            : Math.round((m * productCrop[src + c] + (255 - m) * outData[dst + c]) / 255);
      }
      outMaskData[(y + offsetY) * canvasW + (x + offsetX)] = 255;
    }
  }

  const raw: RawImage = { data: outData, width: canvasW, height: canvasH, channels: 4 };
  const jpeg = await sharp(raw.data, { raw: { width: canvasW, height: canvasH, channels: 4 } })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: opts.jpegQuality ?? 90, chromaSubsampling: "4:4:4" })
    .toBuffer();
  return {
    jpeg,
    raw,
    mask: nonZeroMask({ data: outMaskData, width: canvasW, height: canvasH }),
    width: canvasW,
    height: canvasH,
    placement: {
      crop: region,
      left: offsetX,
      top: offsetY,
      width: targetW,
      height: targetH,
      kernel: PRODUCT_RESIZE_KERNEL,
    },
  };
}

export interface ProductReferenceOptions {
  /**
   * Replace ("replace") or cap ("min") the source alpha with this mask before
   * cropping, matching how the renderer prepared its cutout. Alpha changes
   * the premultiplied resize near the edge, so it must match to compare.
   */
  alpha?: { mask: RawMask; mode: "replace" | "min" };
}

/**
 * The rule 3 reference for a placed product: a canvas of the output size
 * holding, inside placement, the source cutout cropped to placement.crop and
 * scaled to placement.width x placement.height with placement.kernel, and
 * nothing else (no background, shadow, text, color transform or encoding).
 * Alpha is 255 where the product was placed and 0 elsewhere. Built only from
 * the source and the placement, so any recolor a renderer applies after
 * placing the product shows up in fidelityReport(reference, output, mask).
 */
export async function buildProductReference(
  source: RawImage,
  placement: ProductPlacement,
  canvasWidth: number,
  canvasHeight: number,
  opts: ProductReferenceOptions = {},
): Promise<RawImage> {
  let data = source.data;
  if (opts.alpha) {
    const { mask, mode } = opts.alpha;
    if (mask.width !== source.width || mask.height !== source.height) {
      throw new Error(
        `Mask size ${mask.width}x${mask.height} does not match image ${source.width}x${source.height}`,
      );
    }
    data = Buffer.from(source.data);
    for (let i = 0; i < mask.data.length; i++) {
      const o = i * 4 + 3;
      data[o] = mode === "replace" ? mask.data[i] : Math.min(data[o], mask.data[i]);
    }
  }
  const { crop, width, height } = placement;
  const scaled = await sharp(data, {
    raw: { width: source.width, height: source.height, channels: 4 },
  })
    .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
    .resize(width, height, { fit: "fill", kernel: placement.kernel })
    .raw()
    .toBuffer();

  const out = Buffer.alloc(canvasWidth * canvasHeight * 4, 0);
  for (let y = 0; y < height; y++) {
    const cy = placement.top + y;
    if (cy < 0 || cy >= canvasHeight) {
      continue;
    }
    for (let x = 0; x < width; x++) {
      const cx = placement.left + x;
      if (cx < 0 || cx >= canvasWidth) {
        continue;
      }
      const src = (y * width + x) * 4;
      const dst = (cy * canvasWidth + cx) * 4;
      out[dst] = scaled[src];
      out[dst + 1] = scaled[src + 1];
      out[dst + 2] = scaled[src + 2];
      out[dst + 3] = 255;
    }
  }
  return { data: out, width: canvasWidth, height: canvasHeight, channels: 4 };
}

function drawContactShadow(
  data: Buffer,
  width: number,
  height: number,
  ellipse: { cx: number; cy: number; rx: number; ry: number; strength: number },
): void {
  const { cx, cy, rx, ry, strength } = ellipse;
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(width - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(height - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const d = dx * dx + dy * dy;
      if (d >= 1) {
        continue;
      }
      const darken = 1 - strength * (1 - d);
      const o = (y * width + x) * 4;
      data[o] = clampByte(data[o] * darken);
      data[o + 1] = clampByte(data[o + 1] * darken);
      data[o + 2] = clampByte(data[o + 2] * darken);
    }
  }
}

async function encodeUnderLimit(
  raw: RawImage,
  maxBytes: number,
): Promise<{ jpeg: Buffer; quality: number }> {
  let quality = 90;
  for (;;) {
    const jpeg = await sharp(raw.data, {
      raw: { width: raw.width, height: raw.height, channels: 4 },
    })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality, chromaSubsampling: "4:4:4" })
      .toBuffer();
    if (jpeg.length <= maxBytes || quality <= 40) {
      return { jpeg, quality };
    }
    quality -= 10;
  }
}

function assertSameSize(image: RawImage, mask: RawMask): void {
  if (image.width !== mask.width || image.height !== mask.height) {
    throw new Error(
      `Mask size ${mask.width}x${mask.height} does not match image ${image.width}x${image.height}`,
    );
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}
