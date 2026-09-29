/**
 * Deterministic exports built from the user's photo and its cutout mask: the
 * Amazon style white main image, transparent cutout PNG and colored sweep.
 * No generative model touches these pixels (CURVI_BUILD_PLAN.md section 5.7).
 */
import sharp from "sharp";
import { dimensionBounds, type ChannelSpec } from "@curvi/specs";
import { hexToRgb } from "../color";
import { boundingBoxOfMask, nonZeroMask, type BBox } from "../mask";
import { minLongSideFor } from "../qc/pixelChecks";
import { decodeMask, decodeToRgba, type RawImage, type RawMask } from "../raw";
import { canvasDefaults, stillStyle } from "../seed/templates";

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

/**
 * The encoded file is still larger than the spec's byte limit at the lowest
 * JPEG quality and the smallest size the spec accepts. The shot cannot ship
 * and goes to review; retrying the same render cannot help.
 */
export class OutputTooLargeError extends Error {
  constructor(
    message: string,
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(message);
    this.name = "OutputTooLargeError";
  }
}

/** Lowest JPEG quality encodeUnderLimit steps down to. */
export const MIN_JPEG_QUALITY = 40;
/** Each size step shrinks the long side to this share of the previous one. */
const SIZE_STEP = 0.85;
/** Size steps tried before the spec's floor size, which is always tried last. */
const MAX_SIZE_STEPS = 6;

export interface WhitenResult {
  /** Final encoded JPEG, quality (then size) stepped down until under spec.maxBytes. */
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

/** An RGB color as three bytes. */
export type Rgb = readonly [number, number, number];

/** Seed white as bytes, for callers that pass no color. */
function seedWhite(): Rgb {
  const { r, g, b } = hexToRgb(stillStyle.whiteHex);
  return [r, g, b];
}

function rgbHex(rgb: Rgb): string {
  return `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/**
 * Build a channel compliant white background main image:
 * force every pixel outside the mask to pure 255 white, trim to the product
 * bounding box, pad so the product longest side hits the spec fill target,
 * resize with lanczos3 and export an sRGB JPEG at quality 90 under maxBytes.
 * The white comes from spec.background.rgb, or seed white when the spec
 * names none. A wrapper over makeOnBackground.
 *
 * When the JPEG is still over spec.maxBytes at the lowest quality, the
 * canvas steps down in size (same aspect, same fill) toward the smallest
 * size the spec accepts (spec.minLongSide, 1600 for main class specs, or the
 * exact size of an exactSize spec). If even that is too large it throws
 * OutputTooLargeError instead of returning a file QC would reject after
 * paid retries.
 */
export async function makeAmazonMain(
  sourceBuffer: Buffer,
  maskBuffer: Buffer,
  spec: ChannelSpec,
): Promise<WhitenResult> {
  const rgb = spec.background?.rgb ?? seedWhite();
  return makeOnBackground(sourceBuffer, maskBuffer, spec, { rgb: [rgb[0], rgb[1], rgb[2]] });
}

export interface OnBackgroundOptions {
  /** The background color every pixel outside the mask gets. */
  rgb: Rgb;
}

/**
 * The cut out product placed on one flat color, sized for spec: the same
 * geometry, fill target, safe zone and byte limit ladder as the white main
 * image. Semi transparent edge pixels blend toward rgb, never toward white,
 * and pixels inside the mask are never changed.
 */
export async function makeOnBackground(
  sourceBuffer: Buffer,
  maskBuffer: Buffer,
  spec: ChannelSpec,
  opts: OnBackgroundOptions,
): Promise<WhitenResult> {
  const source = await decodeToRgba(sourceBuffer);
  const mask = await decodeMask(maskBuffer);
  assertSameSize(source, mask);

  const bbox = boundingBoxOfMask(mask);
  if (!bbox) {
    throw new Error("Mask is empty, cannot build a main image");
  }

  const canvasW = spec.width ?? canvasDefaults.width;
  const canvasH = spec.height ?? canvasW;
  const fillTarget = spec.fill
    ? clamp(DEFAULT_FILL_TARGET, spec.fill.min, spec.fill.max)
    : DEFAULT_FILL_TARGET;

  let smallest = { bytes: 0, width: canvasW, height: canvasH };
  for (const size of stepDownSizes(canvasW, canvasH, spec)) {
    const safeZone = spec.safeZone ? scaleSafeZone(spec.safeZone, size.height / canvasH) : undefined;
    const placed = await placeOnBackground(source, mask, bbox, size.width, size.height, {
      rgb: opts.rgb,
      fill: fillTarget,
      ...(safeZone ? { safeZone } : {}),
    });
    const encoded = await encodeUnderLimit(placed.raw, spec.maxBytes, rgbHex(opts.rgb));
    if (!encoded.overLimit) {
      return { ...placed, jpeg: encoded.jpeg, jpegQuality: encoded.quality };
    }
    smallest = { bytes: encoded.jpeg.length, width: size.width, height: size.height };
  }
  const maxBytes = spec.maxBytes ?? 0;
  throw new OutputTooLargeError(
    `Main image is ${smallest.bytes} bytes at ${smallest.width}x${smallest.height} and quality ${MIN_JPEG_QUALITY}, over the ${maxBytes} byte limit of ${spec.id}`,
    smallest.bytes,
    maxBytes,
  );
}

/** A spec safe zone scaled to a smaller canvas of the same aspect. */
function scaleSafeZone(zone: { top: number; bottom: number }, scale: number): { top: number; bottom: number } {
  return { top: Math.ceil(zone.top * scale), bottom: Math.ceil(zone.bottom * scale) };
}

/**
 * Canvas sizes to try, largest first: the spec size, then shrinking steps of
 * the same aspect down to the smallest size the spec accepts, which is
 * always tried last. An exactSize spec (or one already at its floor) gets a
 * single size.
 */
export function stepDownSizes(
  canvasW: number,
  canvasH: number,
  spec: ChannelSpec,
): Array<{ width: number; height: number }> {
  const bounds = dimensionBounds(spec);
  const long = Math.max(canvasW, canvasH);
  const floorScale = Math.min(
    1,
    Math.max(minLongSideFor(spec) / long, bounds.minWidth / canvasW, bounds.minHeight / canvasH),
  );
  const sizeAt = (scale: number): { width: number; height: number } => ({
    width: Math.max(1, Math.ceil(canvasW * scale)),
    height: Math.max(1, Math.ceil(canvasH * scale)),
  });
  const sizes = [sizeAt(1)];
  let scale = 1;
  for (let i = 0; i < MAX_SIZE_STEPS; i++) {
    scale *= SIZE_STEP;
    if (scale <= floorScale) {
      break;
    }
    sizes.push(sizeAt(scale));
  }
  if (floorScale < 1) {
    sizes.push(sizeAt(floorScale));
  }
  return sizes;
}

export interface BackgroundPlacementOptions {
  /** Background color; semi transparent edges blend toward it. */
  rgb: Rgb;
  /** Product longest side over the canvas longest side. */
  fill: number;
  /** Rows at the top and bottom the product must stay clear of (meta.story_9x16). */
  safeZone?: { top: number; bottom: number };
}

/** A product placed on a flat background at one canvas size, before encoding. */
export type PlacedOnBackground = Omit<WhitenResult, "jpeg" | "jpegQuality">;

/**
 * The product on a flat color at one canvas size, before encoding. Every
 * pixel outside the mask is exactly rgb; a pixel where the mask is 255 is the
 * scaled product, unchanged; an edge pixel blends the product toward rgb by
 * the mask value, so the blend itself never adds a light fringe on a dark
 * background. The product is centered horizontally and, inside the safe
 * zone when one is given, vertically.
 */
export async function placeOnBackground(
  source: RawImage,
  mask: RawMask,
  bbox: BBox,
  canvasW: number,
  canvasH: number,
  opts: BackgroundPlacementOptions,
): Promise<PlacedOnBackground> {
  const canvasLong = Math.max(canvasW, canvasH);
  const zoneTop = opts.safeZone?.top ?? 0;
  const zoneH = Math.max(1, canvasH - zoneTop - (opts.safeZone?.bottom ?? 0));
  const [bgR, bgG, bgB] = opts.rgb;

  // Scale so the product longest side hits the fill target, but never overflow
  // either canvas axis (or the safe zone).
  const bboxLong = Math.max(bbox.width, bbox.height);
  const scale = Math.min(
    (opts.fill * canvasLong) / bboxLong,
    (canvasW * canvasDefaults.maxAxisShare) / bbox.width,
    (zoneH * canvasDefaults.maxAxisShare) / bbox.height,
  );
  const targetW = Math.max(1, Math.round(bbox.width * scale));
  const targetH = Math.max(1, Math.round(bbox.height * scale));

  // Crop image and mask to the product bounding box, then resize both with
  // lanczos3. The mask picks up anti aliased edges that blend the product into
  // the background smoothly.
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

  // Manual composite over the flat color so the background is exact by
  // construction, not by trusting a codec or a blend mode.
  const outData = Buffer.alloc(canvasW * canvasH * 4);
  for (let i = 0; i < canvasW * canvasH; i++) {
    const o = i * 4;
    outData[o] = bgR;
    outData[o + 1] = bgG;
    outData[o + 2] = bgB;
    outData[o + 3] = 255;
  }
  const outMaskData = Buffer.alloc(canvasW * canvasH, 0);
  const offsetX = Math.floor((canvasW - targetW) / 2);
  const offsetY = zoneTop + Math.max(0, Math.floor((zoneH - targetH) / 2));
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
        outData[dst] = Math.round((m * productCrop[src] + (255 - m) * bgR) / 255);
        outData[dst + 1] = Math.round((m * productCrop[src + 1] + (255 - m) * bgG) / 255);
        outData[dst + 2] = Math.round((m * productCrop[src + 2] + (255 - m) * bgB) / 255);
      }
      outMaskData[(y + offsetY) * canvasW + (x + offsetX)] = 255;
    }
  }

  return {
    raw: { data: outData, width: canvasW, height: canvasH, channels: 4 },
    mask: { data: outMaskData, width: canvasW, height: canvasH },
    width: canvasW,
    height: canvasH,
    fillRatio: Math.max(targetW, targetH) / canvasLong,
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

  const canvasW = opts.width ?? canvasDefaults.width;
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
    .flatten({ background: stillStyle.whiteHex })
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

/**
 * The rule 3 reference for a kept photo (PHASE_15 fidelity section), built
 * straight from the stored upload's encoded bytes with its own sharp
 * pipeline: upright per EXIF, the same ICC to sRGB transform the renderer
 * applies (only when the file embeds a profile), placement.crop extracted
 * when it is not the whole frame, resized to placement.width x
 * placement.height with placement.kernel and fastShrinkOnLoad off when the
 * size changes, then 8 bit sRGB. It shares no code with
 * deterministic/original.ts, so a drift in the renderer shows up in
 * fidelityReport, and libvips streams the source, so the full frame is never
 * decoded into JS memory; only the placed rectangle is.
 *
 * Alpha is 255 inside the placed rectangle and 0 elsewhere; for a photo with
 * an alpha channel it is the photo's own (resized) alpha instead.
 */
export async function buildProductReferenceFromEncoded(
  sourceBytes: Buffer,
  placement: ProductPlacement,
  canvas: { width: number; height: number },
): Promise<RawImage> {
  const meta = await sharp(sourceBytes).metadata();
  const swapped = (meta.orientation ?? 1) >= 5;
  const fullW = (swapped ? meta.height : meta.width) ?? 0;
  const fullH = (swapped ? meta.width : meta.height) ?? 0;
  const { crop, width, height } = placement;
  let pipeline = sharp(sourceBytes).rotate();
  if (meta.icc) {
    pipeline = pipeline.withIccProfile("srgb");
  }
  const whole = crop.left === 0 && crop.top === 0 && crop.width === fullW && crop.height === fullH;
  if (!whole) {
    pipeline = pipeline.extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height });
  }
  if (width !== crop.width || height !== crop.height) {
    pipeline = pipeline.resize(width, height, { fit: "fill", kernel: placement.kernel, fastShrinkOnLoad: false });
  }
  const { data: scaled, info } = await pipeline
    .toColourspace("srgb")
    .ensureAlpha()
    .raw({ depth: "uchar" })
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4 || info.width !== width || info.height !== height) {
    throw new Error(`Reference decode gave ${info.width}x${info.height}x${info.channels}, expected ${width}x${height}x4`);
  }
  const keepAlpha = meta.hasAlpha === true;

  // The photo fills the canvas (a kept photo in its own shape): the scaled
  // pixels are the reference, with no second canvas sized copy.
  if (placement.left === 0 && placement.top === 0 && width === canvas.width && height === canvas.height) {
    if (!keepAlpha) {
      for (let o = 3; o < scaled.length; o += 4) {
        scaled[o] = 255;
      }
    }
    return { data: scaled, width, height, channels: 4 };
  }

  const out = Buffer.alloc(canvas.width * canvas.height * 4, 0);
  for (let y = 0; y < height; y++) {
    const cy = placement.top + y;
    if (cy < 0 || cy >= canvas.height) {
      continue;
    }
    for (let x = 0; x < width; x++) {
      const cx = placement.left + x;
      if (cx < 0 || cx >= canvas.width) {
        continue;
      }
      const src = (y * width + x) * 4;
      const dst = (cy * canvas.width + cx) * 4;
      out[dst] = scaled[src];
      out[dst + 1] = scaled[src + 1];
      out[dst + 2] = scaled[src + 2];
      out[dst + 3] = keepAlpha ? scaled[src + 3] : 255;
    }
  }
  return { data: out, width: canvas.width, height: canvas.height, channels: 4 };
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

export interface EncodeUnderLimitResult {
  jpeg: Buffer;
  quality: number;
  /** True when even MIN_JPEG_QUALITY is over maxBytes; the caller must not ship it. */
  overLimit: boolean;
}

/**
 * JPEG at quality 90, stepping down by 10 to MIN_JPEG_QUALITY until the file
 * fits maxBytes. With no limit the first encode is final. The result says
 * whether it fits, so a caller can never ship an oversized file by accident.
 * Any transparency is flattened onto flattenHex (seed white by default): the
 * color the canvas was placed on.
 */
export async function encodeUnderLimit(
  raw: RawImage,
  maxBytes: number | undefined,
  flattenHex: string = stillStyle.whiteHex,
): Promise<EncodeUnderLimitResult> {
  let quality = 90;
  for (;;) {
    const jpeg = await sharp(raw.data, {
      raw: { width: raw.width, height: raw.height, channels: 4 },
    })
      .flatten({ background: flattenHex })
      .jpeg({ quality, chromaSubsampling: "4:4:4" })
      .toBuffer();
    if (maxBytes === undefined || jpeg.length <= maxBytes) {
      return { jpeg, quality, overLimit: false };
    }
    if (quality <= MIN_JPEG_QUALITY) {
      return { jpeg, quality, overLimit: true };
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
