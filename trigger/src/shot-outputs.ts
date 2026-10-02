/**
 * Helpers that turn a rendered canvas into the file that ships for one
 * channel spec, and measure that file (Update.md 2.2, 2.3, 2.11, 2.15).
 *
 * - encodeForSpec picks a format and quality the spec allows and returns the
 *   pixels decoded from those exact bytes, so QC always measures the file the
 *   seller receives, never the canvas before encoding.
 * - qcErodeWithFloor and the erosion helpers size the rule 3 fidelity check
 *   region so thin products (chains, cables, rings) keep a real region to
 *   compare instead of eroding to nothing, without ever reaching into pixels
 *   that were blended with the background.
 * - resizeCanvasTo re-frames one channel's canvas for another channel's size.
 * - measureBackgroundRgb reports the background color the file really has,
 *   for the compliance badge.
 *
 * Nothing here regenerates product pixels (CLAUDE.md rule 3): canvases are
 * only cropped, scaled and encoded, and every result is checked against the
 * product reference transformed the same way.
 */

import {
  boundingBoxOfMask,
  decodeMask,
  decodeToRgba,
  deriveQcErodePx,
  dilate,
  encodeJpeg,
  encodePng,
  erode,
  fidelityReport,
  maskToSharp,
  MIN_PASTE_AREA_SHARE,
  qcKindForSpec,
  rawToSharp,
  type QcKind,
  type RawImage,
  type RawMask,
} from "@curvi/pipeline";
import { hexToRgb } from "@curvi/pipeline/output-options";
import { stillStyle } from "@curvi/pipeline/seed";
import { dimensionBounds, requiresWhiteBackground, type ChannelSpec } from "@curvi/specs";
import { ShotUnavailableError } from "./errors";

/** Matches the QC edge margin the runner passes to pixelChecks. */
export const QC_EDGE_MARGIN_PX = 2;

/**
 * The fidelity check keeps at least this share of the product mask when it
 * lowers its erosion for a thin product: the same share the composite paste
 * back guarantees for its pure paste region.
 */
export const MIN_QC_AREA_SHARE = MIN_PASTE_AREA_SHARE;

/** Lanczos3 reaches 3 source pixels on each side of an edge. */
export const RESIZE_KERNEL_REACH_PX = 3;

/** JPEG quality ladder, same steps as the whiten helper's encoder. */
const JPEG_QUALITIES = [90, 80, 70, 60, 50, 40] as const;
/** Higher qualities tried, in order, when a JPEG fails the rule 3 check. */
const JPEG_FIDELITY_QUALITIES = [95, 98, 100] as const;

/** Mask values at or above this are product, the convention of erode(). */
const BINARY_THRESHOLD = 128;

/** Product pixels in a mask, by the binary convention erode() uses. */
export function maskArea(mask: RawMask): number {
  let area = 0;
  for (let i = 0; i < mask.data.length; i++) {
    if (mask.data[i] >= BINARY_THRESHOLD) area += 1;
  }
  return area;
}

/**
 * The fidelity erosion to use for this mask: the desired erosion when it
 * leaves at least minShare of the mask to compare, otherwise the largest
 * smaller erosion that does, never below floorPx. floorPx is the depth below
 * which pixels may be blended with the background (the paste erosion for a
 * composite, the resize edge band for a still), so the check never reaches
 * into them. A thin product therefore keeps a real, non vacuous check region
 * instead of failing with an empty one on every attempt.
 */
export async function qcErodeWithFloor(
  mask: RawMask,
  desiredPx: number,
  floorPx: number,
  minShare: number = MIN_QC_AREA_SHARE,
): Promise<number> {
  const desired = Math.max(0, Math.ceil(desiredPx));
  const floor = Math.min(desired, Math.max(0, Math.ceil(floorPx)));
  const total = maskArea(mask);
  if (total === 0 || desired === floor) {
    return desired;
  }
  const needed = total * minShare;
  const keeps = async (px: number): Promise<boolean> => maskArea(await erode(mask, px)) >= needed;
  if (await keeps(desired)) {
    return desired;
  }
  // Area only shrinks as erosion grows, so search for the largest erosion in
  // (floor, desired) that still keeps enough of the mask.
  let lo = floor;
  let hi = desired - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (await keeps(mid)) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/** A fidelity check region: the erosion to apply and the lowest it may go. */
export interface QcErosion {
  erodePx: number;
  floorPx: number;
}

/**
 * Erosion for a composite: the package default derived from the paste
 * parameters actually applied, floored at the paste erosion itself. Inside
 * that erosion every pixel is pasted back byte for byte (the feather only
 * works outward), so the floor is still strictly inside the pure paste region.
 */
export async function compositeQcErosion(canvasMask: RawMask, effectivePasteErodePx: number): Promise<QcErosion> {
  const floorPx = Math.max(0, Math.floor(effectivePasteErodePx));
  const erodePx = await qcErodeWithFloor(canvasMask, deriveQcErodePx(floorPx), floorPx);
  return { erodePx, floorPx };
}

/**
 * Erosion for a still whose product was scaled by `scale`. The resize blends
 * product and background within the kernel's reach, which in canvas pixels is
 * the reach times the scale when scaling up, so the desired erosion clears the
 * whole band. Pixels deeper than one source pixel (plus one canvas pixel) are
 * already within a few levels of the product, which is the floor a thin
 * product may fall back to.
 */
export async function stillQcErosion(placedMask: RawMask, scale: number): Promise<QcErosion> {
  const up = Math.max(1, Number.isFinite(scale) ? scale : 1);
  const desired = Math.max(deriveQcErodePx(), Math.ceil(RESIZE_KERNEL_REACH_PX * up) + 1);
  const floorPx = Math.ceil(up) + 1;
  const erodePx = await qcErodeWithFloor(placedMask, desired, floorPx);
  return { erodePx, floorPx: Math.min(floorPx, erodePx) };
}

export interface EncodeOptions {
  /** An already encoded quality 90 JPEG of raw, reused as the first rung. */
  firstJpeg?: Buffer;
  /** The fidelity erosion the runner applies; the ladder checks with the same. */
  erodePx?: number;
  /** Try lossless PNG before the JPEG ladder when the spec takes PNG. */
  preferPng?: boolean;
  /** The fidelity threshold row, when it is not the spec's own: "main" for
   * a kept photo, whose pixels must hold the strict row on every spec
   * (PHASE_15 fidelity section). */
  fidelityKind?: QcKind;
  /** The mask whose dilation marks what is not background for the exact
   * background check, when it differs from the fidelity mask: the product
   * inside an already white kept photo, whose own white must stay exact. */
  backgroundMask?: RawMask;
}

/**
 * The flat color a JPEG must keep exactly outside the QC edge margin, or null
 * when the spec has no such rule: a solid spec's own color, and white for
 * every white or transparent and white preferred spec (their white rule,
 * PHASE_15 item 19), so codec ringing that dirties the white sends the file
 * to PNG instead of failing the white check.
 */
export function exactBackgroundRgb(spec: ChannelSpec): readonly [number, number, number] | null {
  if (spec.background?.type === "solid" && spec.background.rgb) {
    return spec.background.rgb;
  }
  if (requiresWhiteBackground(spec)) {
    return spec.background?.rgb ?? hexToRgb(stillStyle.whiteHex);
  }
  return null;
}

export interface EncodedOutput {
  /** Pixels decoded from the encoded bytes: exactly what ships. */
  image: RawImage;
  encoded: { buffer: Buffer; format: string };
}

/**
 * Pick an encoding the spec allows and that fits spec.maxBytes, and return it
 * with the pixels decoded from those exact bytes. PNG first when preferPng is
 * set; otherwise JPEG first (stepping quality down to fit), then lossless PNG.
 * For a solid background spec, and a white or transparent or white preferred
 * one, a JPEG is only kept when its decoded background is still exactly the
 * spec color (white) outside the QC edge margin; codec ringing that dirties
 * it sends the shot to PNG. A JPEG is also only kept when its
 * product pixels pass the same rule 3 fidelity check the runner applies. When
 * codec error pushes pixels past the limit, higher qualities are tried, then
 * PNG, instead of loosening the check. When nothing the spec accepts passes,
 * the output needs review.
 */
export async function encodeForSpec(
  raw: RawImage,
  mask: RawMask,
  productReference: RawImage,
  spec: ChannelSpec,
  opts: EncodeOptions = {},
): Promise<EncodedOutput> {
  const maxBytes = spec.maxBytes ?? Number.POSITIVE_INFINITY;
  const allows = (f: string): boolean => !spec.formats || (spec.formats as readonly string[]).includes(f);
  const solidRgb = exactBackgroundRgb(spec) ?? undefined;
  const checkMask = solidRgb ? await dilate(opts.backgroundMask ?? mask, QC_EDGE_MARGIN_PX) : null;
  const kind = opts.fidelityKind ?? qcKindForSpec(spec);
  const fidelityOpts = { kind, ...(opts.erodePx !== undefined ? { erodePx: opts.erodePx } : {}) };

  const tryPng = async (): Promise<EncodedOutput | null> => {
    if (!allows("png")) {
      return null;
    }
    const buffer = await encodePng(raw);
    if (buffer.length > maxBytes) {
      return null;
    }
    return { image: await decodeToRgba(buffer), encoded: { buffer, format: "png" } };
  };

  const jpegPasses = async (image: RawImage): Promise<boolean> => {
    if (solidRgb && checkMask && !backgroundExact(image, checkMask, solidRgb)) {
      return false;
    }
    return (await fidelityReport(productReference, image, mask, fidelityOpts)).pass;
  };

  if (opts.preferPng) {
    const png = await tryPng();
    if (png) {
      return png;
    }
  }

  if (allows("jpg")) {
    for (const quality of JPEG_QUALITIES) {
      const buffer =
        quality === JPEG_QUALITIES[0] && opts.firstJpeg ? opts.firstJpeg : await encodeJpeg(raw, quality);
      if (buffer.length > maxBytes) {
        continue;
      }
      const image = await decodeToRgba(buffer);
      if (solidRgb && checkMask && !backgroundExact(image, checkMask, solidRgb)) {
        // Lower quality only adds more ringing; go straight to PNG.
        break;
      }
      if (await jpegPasses(image)) {
        return { image, encoded: { buffer, format: "jpg" } };
      }
      // Lower quality only drifts further from the product; try higher.
      for (const higher of JPEG_FIDELITY_QUALITIES) {
        if (higher <= quality) {
          continue;
        }
        const better = await encodeJpeg(raw, higher);
        if (better.length > maxBytes) {
          break;
        }
        const betterImage = await decodeToRgba(better);
        if (await jpegPasses(betterImage)) {
          return { image: betterImage, encoded: { buffer: better, format: "jpg" } };
        }
      }
      break;
    }
  }
  if (!opts.preferPng) {
    const png = await tryPng();
    if (png) {
      return png;
    }
  }
  throw new ShotUnavailableError(
    "We could not save this image in a format and size this channel accepts without changing the product, so it needs review.",
  );
}

function backgroundExact(image: RawImage, checkMask: RawMask, rgb: readonly [number, number, number]): boolean {
  for (let i = 0; i < checkMask.data.length; i++) {
    if (checkMask.data[i] !== 0) {
      continue;
    }
    const o = i * 4;
    if (image.data[o] !== rgb[0] || image.data[o + 1] !== rgb[1] || image.data[o + 2] !== rgb[2]) {
      return false;
    }
  }
  return true;
}

/** Canvas size for a spec; the one rule lives in @curvi/pipeline. */
export { canvasSizeFor } from "@curvi/pipeline/output-options";

/** True when a width x height file meets the spec's size rules. */
export function fitsSpecSize(spec: ChannelSpec, width: number, height: number): boolean {
  if (spec.width !== undefined && spec.width !== width) return false;
  if (spec.height !== undefined && spec.height !== height) return false;
  const bounds = dimensionBounds(spec);
  const longest = Math.max(width, height);
  if (width < bounds.minWidth || width > bounds.maxWidth) return false;
  if (height < bounds.minHeight || height > bounds.maxHeight) return false;
  if (longest < bounds.minLongSide || longest > bounds.maxLongSide) return false;
  if (spec.maxMegapixels !== undefined && (width * height) / 1_000_000 > spec.maxMegapixels) return false;
  return true;
}

/** Same aspect ratio within one percent. */
export function sameAspect(a: { width: number; height: number }, b: { width: number; height: number }): boolean {
  const ra = a.width / a.height;
  const rb = b.width / b.height;
  return Math.abs(ra - rb) / rb <= 0.01;
}

export interface ResizedCanvas {
  image: RawImage;
  mask: RawMask;
  productReference: RawImage;
  erosion: QcErosion;
}

/**
 * Re-frames a finished canvas for another channel size: crops to the target
 * aspect around the product (refusing when the crop would cut the product
 * off), then scales with lanczos3. The mask and the product reference go
 * through the same crop and scale, and the fidelity erosion grows by the
 * kernel's reach, so the check still compares only pixels whose resize
 * support lies inside the region that matched before.
 */
export async function resizeCanvasTo(
  canvas: RawImage,
  mask: RawMask,
  productReference: RawImage,
  erosion: QcErosion,
  target: { width: number; height: number },
): Promise<ResizedCanvas> {
  const bbox = boundingBoxOfMask(mask);
  if (!bbox) {
    throw new ShotUnavailableError("This image has no product to place for this channel, so it needs review.");
  }
  const targetRatio = target.width / target.height;
  let cropW = canvas.width;
  let cropH = canvas.height;
  if (!sameAspect(canvas, target)) {
    if (canvas.width / canvas.height > targetRatio) {
      cropW = Math.min(canvas.width, Math.round(canvas.height * targetRatio));
    } else {
      cropH = Math.min(canvas.height, Math.round(canvas.width / targetRatio));
    }
  }
  if (bbox.width > cropW || bbox.height > cropH) {
    throw new ShotUnavailableError(
      "The product would be cut off at this channel's shape, so this image needs review.",
    );
  }
  const centerX = bbox.left + bbox.width / 2;
  const centerY = bbox.top + bbox.height / 2;
  const left = clamp(Math.round(centerX - cropW / 2), 0, canvas.width - cropW);
  const top = clamp(Math.round(centerY - cropH / 2), 0, canvas.height - cropH);
  // The crop must hold the whole product even after clamping to the canvas.
  if (bbox.left < left || bbox.top < top || bbox.left + bbox.width > left + cropW || bbox.top + bbox.height > top + cropH) {
    throw new ShotUnavailableError(
      "The product would be cut off at this channel's shape, so this image needs review.",
    );
  }

  const region = { left, top, width: cropW, height: cropH };
  const identity = cropW === target.width && cropH === target.height;
  const opaqueReference = withOpaqueAlpha(productReference);
  const resizeImage = async (img: RawImage): Promise<RawImage> => {
    let pipeline = rawToSharp(img).extract(region);
    if (!identity) {
      pipeline = pipeline.resize(target.width, target.height, { fit: "fill", kernel: "lanczos3" });
    }
    const data = await pipeline.ensureAlpha().raw().toBuffer();
    return { data, width: target.width, height: target.height, channels: 4 };
  };
  const image = await resizeImage(withOpaqueAlpha(canvas));
  const reference = await resizeImage(opaqueReference);
  let maskPipeline = maskToSharp(mask).extract(region);
  if (!identity) {
    maskPipeline = maskPipeline.resize(target.width, target.height, { fit: "fill", kernel: "lanczos3" });
  }
  const maskData = await maskPipeline.toColourspace("b-w").raw().toBuffer();
  const resizedMask: RawMask = { data: binarize(maskData), width: target.width, height: target.height };

  if (identity) {
    return { image, mask: resizedMask, productReference: reference, erosion };
  }
  const scale = target.width / cropW;
  const reach = RESIZE_KERNEL_REACH_PX * Math.max(1, scale);
  const floorPx = Math.ceil(erosion.floorPx * scale + reach) + 1;
  const desired = Math.max(floorPx, Math.ceil(erosion.erodePx * scale + reach) + 1);
  const erodePx = await qcErodeWithFloor(resizedMask, desired, floorPx);
  return { image, mask: resizedMask, productReference: reference, erosion: { erodePx, floorPx } };
}

function withOpaqueAlpha(img: RawImage): RawImage {
  const data = Buffer.from(img.data);
  for (let i = 3; i < data.length; i += 4) {
    data[i] = 255;
  }
  return { data, width: img.width, height: img.height, channels: 4 };
}

function binarize(data: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] >= BINARY_THRESHOLD ? 255 : 0;
  }
  return out;
}

/**
 * The background color the file really has: the most common opaque color
 * outside the product mask grown by the QC edge margin (the whole image when
 * there is no mask). Null when no opaque background pixel exists, for
 * example a transparent cutout.
 */
export async function measureBackgroundRgb(
  image: RawImage,
  mask: RawMask | null,
  edgeMarginPx: number = QC_EDGE_MARGIN_PX,
): Promise<[number, number, number] | null> {
  const outside =
    mask && mask.width === image.width && mask.height === image.height ? await dilate(mask, edgeMarginPx) : null;
  const counts = new Map<number, number>();
  let best = -1;
  let bestCount = 0;
  let last = -1;
  let lastCount = 0;
  const flush = (): void => {
    if (last < 0) return;
    const total = (counts.get(last) ?? 0) + lastCount;
    counts.set(last, total);
    if (total > bestCount) {
      best = last;
      bestCount = total;
    }
  };
  const pixels = image.width * image.height;
  for (let i = 0; i < pixels; i++) {
    if (outside && outside.data[i] !== 0) continue;
    const o = i * 4;
    if (image.data[o + 3] !== 255) continue;
    const key = (image.data[o] << 16) | (image.data[o + 1] << 8) | image.data[o + 2];
    // Backgrounds are mostly long runs of one color; count runs, not pixels.
    if (key === last) {
      lastCount += 1;
      continue;
    }
    flush();
    last = key;
    lastCount = 1;
  }
  flush();
  if (best < 0) {
    return null;
  }
  return [(best >> 16) & 0xff, (best >> 8) & 0xff, best & 0xff];
}

/** Single channel PNG of a mask, compact enough to cross a task boundary. */
export function encodeMaskPng(mask: RawMask): Promise<Buffer> {
  return maskToSharp(mask).png().toBuffer();
}

/** Inverse of encodeMaskPng. */
export function decodeMaskPng(png: Buffer): Promise<RawMask> {
  return decodeMask(png);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
