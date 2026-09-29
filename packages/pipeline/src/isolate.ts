/**
 * Target product isolation (docs/phases/PHASE_13.md item 3). When a photo
 * shows more than one product, the runner crops the working photo to the
 * product the seller means before the cutout, and afterwards keeps only the
 * cutout's connected pieces that overlap that product's box. Pixels are only
 * cropped, kept byte for byte or made fully transparent: nothing here
 * regenerates or alters a product pixel (CLAUDE.md rule 3).
 *
 * Boxes arrive normalized to 0..1 of the upright photo (NormalizedBox in
 * schemas.ts) and are converted here with the size of the image in hand.
 */
import sharp from "sharp";
import type { BBox } from "./mask";
import type { RawImage, RawMask } from "./raw";
import type { NormalizedBox } from "./schemas";

/** A rectangle in whole pixels of one image. */
export type PixelRect = BBox;

/** Margin around the target box when the photo is cropped before the
 * cutout, as a share of the box's own width and height on each side. */
export const TARGET_CROP_MARGIN = 0.1;

/** Mask pieces under this share of the image area are noise: they never
 * count as another product and never decide a refusal. */
export const NOISE_AREA_SHARE = 0.005;

/** Alpha above this is product, matching the live cutout mask. */
export const CUTOUT_ALPHA_THRESHOLD = 8;

/** A normalized box in pixels of a width x height image, at least one pixel
 * and never outside the image. */
export function boxToPixels(box: NormalizedBox, width: number, height: number): PixelRect {
  const left = clamp(floorPx(box.x * width), 0, width - 1);
  const top = clamp(floorPx(box.y * height), 0, height - 1);
  const right = clamp(ceilPx((box.x + box.width) * width), left + 1, width);
  const bottom = clamp(ceilPx((box.y + box.height) * height), top + 1, height);
  return { left, top, width: right - left, height: bottom - top };
}

/** The crop for a target box: the box plus margin times its size on every
 * side, clamped to the image. */
export function targetCropRect(
  box: NormalizedBox,
  width: number,
  height: number,
  margin = TARGET_CROP_MARGIN,
): PixelRect {
  const grown: NormalizedBox = {
    x: box.x - box.width * margin,
    y: box.y - box.height * margin,
    width: box.width * (1 + 2 * margin),
    height: box.height * (1 + 2 * margin),
  };
  const x0 = Math.max(0, grown.x);
  const y0 = Math.max(0, grown.y);
  const x1 = Math.min(1, grown.x + grown.width);
  const y1 = Math.min(1, grown.y + grown.height);
  return boxToPixels({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, width, height);
}

/** A photo cropped to a target box plus margin, and where the crop sits. */
export interface TargetCrop {
  /** The crop as a lossless PNG. */
  bytes: Buffer;
  /** Size of the upright photo the box is normalized to. */
  source: { width: number; height: number };
  /** The crop in pixels of that photo. */
  rect: PixelRect;
}

/**
 * Crops a photo, turned upright per EXIF, to a normalized box plus margin on
 * each side, as a lossless PNG: a crop only, no resampling. Null when the
 * bytes cannot be read.
 */
export async function cropToTarget(
  photo: Buffer,
  box: NormalizedBox,
  margin = TARGET_CROP_MARGIN,
): Promise<TargetCrop | null> {
  try {
    const meta = await sharp(photo).metadata();
    // Orientations 5 to 8 swap width and height once turned upright.
    const swapped = (meta.orientation ?? 1) >= 5;
    const width = (swapped ? meta.height : meta.width) ?? 0;
    const height = (swapped ? meta.width : meta.height) ?? 0;
    if (width <= 0 || height <= 0) {
      return null;
    }
    const rect = targetCropRect(box, width, height, margin);
    const bytes = await sharp(photo).rotate().extract(rect).png().toBuffer();
    return { bytes, source: { width, height }, rect };
  } catch {
    return null;
  }
}

/** A box normalized to one image, re-expressed in pixels of a crop of it:
 * the crop's rect in source pixels, then scaled to the frame the crop is
 * held at (a cutout may come back at another size than it was sent). The
 * result may reach outside the frame; it is clamped to it. */
export function boxInCrop(
  box: NormalizedBox,
  source: { width: number; height: number },
  crop: PixelRect,
  frame: { width: number; height: number },
): PixelRect | null {
  const sx = frame.width / crop.width;
  const sy = frame.height / crop.height;
  const left = (box.x * source.width - crop.left) * sx;
  const top = (box.y * source.height - crop.top) * sy;
  const right = ((box.x + box.width) * source.width - crop.left) * sx;
  const bottom = ((box.y + box.height) * source.height - crop.top) * sy;
  const l = clamp(floorPx(left), 0, frame.width);
  const t = clamp(floorPx(top), 0, frame.height);
  const r = clamp(ceilPx(right), 0, frame.width);
  const b = clamp(ceilPx(bottom), 0, frame.height);
  if (r <= l || b <= t) {
    return null;
  }
  return { left: l, top: t, width: r - l, height: b - t };
}

/** One 8 connected piece of a mask. */
export interface MaskComponent {
  /** 1 based label in MaskComponents.labels. */
  label: number;
  area: number;
  bbox: BBox;
}

export interface MaskComponents {
  /** Per pixel label, 0 for background. */
  labels: Int32Array;
  /** In label order, which is the row major order of each piece's first pixel. */
  components: MaskComponent[];
}

/**
 * Splits a mask into 8 connected components of pixels above threshold.
 * Deterministic: labels follow the row major order of each piece's first
 * pixel, and the fill is an explicit stack (no recursion).
 */
export function maskComponents(mask: RawMask, threshold = 127): MaskComponents {
  const { data, width, height } = mask;
  const labels = new Int32Array(width * height);
  const components: MaskComponent[] = [];
  const stack: number[] = [];
  for (let start = 0; start < data.length; start++) {
    if (labels[start] !== 0 || data[start] <= threshold) continue;
    const label = components.length + 1;
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    labels[start] = label;
    stack.push(start);
    while (stack.length > 0) {
      const idx = stack.pop() as number;
      const x = idx % width;
      const y = (idx - x) / width;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= width) continue;
          const n = ny * width + nx;
          if (labels[n] === 0 && data[n] > threshold) {
            labels[n] = label;
            stack.push(n);
          }
        }
      }
    }
    components.push({ label, area, bbox: { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 } });
  }
  return { labels, components };
}

/** Smallest area, in pixels, a piece needs to count as more than noise. */
export function significantArea(width: number, height: number, share = NOISE_AREA_SHARE): number {
  return Math.max(1, Math.ceil(width * height * share));
}

/** Mask pieces that are not noise (at least share of the mask's area). */
export function significantComponents(mask: RawMask, share = NOISE_AREA_SHARE, threshold = 127): MaskComponent[] {
  const min = significantArea(mask.width, mask.height, share);
  return maskComponents(mask, threshold).components.filter((c) => c.area >= min);
}

function inRect(x: number, y: number, r: PixelRect): boolean {
  return x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;
}

export interface IsolationResult {
  /** The cutout with every piece that is not the target made fully
   * transparent (all four bytes zero); kept pixels are byte identical. */
  image: RawImage;
  /** Pieces kept, and pieces removed (noise included). */
  kept: number;
  removed: number;
  /**
   * True when the target cannot be separated from another product: a second
   * significant piece overlaps the target box, or a kept piece reaches a
   * significant way into another product's box (the products touch). The
   * shot must then be refused, not delivered with both.
   */
  touching: boolean;
}

/**
 * Keeps only the cutout pieces that overlap the target box and zeroes the
 * rest. A pixel whose alpha is at or under CUTOUT_ALPHA_THRESHOLD belongs to
 * no piece; it is kept when it sits inside a kept piece's bounding box (the
 * product's soft edge) and zeroed otherwise.
 */
export function isolateTarget(
  cutout: RawImage,
  target: PixelRect,
  others: readonly PixelRect[] = [],
  opts: { noiseShare?: number } = {},
): IsolationResult {
  const { width, height } = cutout;
  const alpha = Buffer.alloc(width * height);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = cutout.data[i * 4 + 3];
  }
  const { labels, components } = maskComponents({ data: alpha, width, height }, CUTOUT_ALPHA_THRESHOLD);
  const minArea = significantArea(width, height, opts.noiseShare ?? NOISE_AREA_SHARE);

  // Per piece: pixels inside the target box, and pixels inside another
  // product's box but outside the target box.
  const inTarget = new Int32Array(components.length + 1);
  const inOther = new Int32Array(components.length + 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const label = labels[y * width + x];
      if (label === 0) continue;
      if (inRect(x, y, target)) {
        inTarget[label]++;
      } else if (others.some((r) => inRect(x, y, r))) {
        inOther[label]++;
      }
    }
  }
  const keep = new Uint8Array(components.length + 1);
  const keptBoxes: BBox[] = [];
  let significantKept = 0;
  let intrudes = false;
  for (const c of components) {
    if (inTarget[c.label] > 0) {
      keep[c.label] = 1;
      keptBoxes.push(c.bbox);
      if (c.area >= minArea) significantKept++;
      if (inOther[c.label] >= minArea) intrudes = true;
    }
  }

  const out = Buffer.from(cutout.data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const label = labels[i];
      const kept = label !== 0 ? keep[label] === 1 : keptBoxes.some((b) => inRect(x, y, b));
      if (!kept) {
        out.fill(0, i * 4, i * 4 + 4);
      }
    }
  }
  const keptCount = keptBoxes.length;
  return {
    image: { data: out, width, height, channels: 4 },
    kept: keptCount,
    removed: components.length - keptCount,
    touching: significantKept > 1 || intrudes,
  };
}

/** Floor and ceil that forgive floating point noise (0.46 * 1000 is
 * 459.99999999999994), so a box lands on the pixel it names. */
function floorPx(value: number): number {
  return Math.floor(value + 1e-6);
}

function ceilPx(value: number): number {
  return Math.ceil(value - 1e-6);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
