/**
 * Mask utilities on raw single channel buffers via sharp. A mask value of 255
 * means product, 0 means background. Masks are thresholded to binary before
 * morphological operations.
 */
import { maskToSharp, type RawMask } from "./raw";

export interface BBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

const BINARY_THRESHOLD = 128;

/**
 * Note on sharp 0.34 morphology: measured on this machine, sharp's erode()
 * grows WHITE regions and dilate() shrinks them (its foreground convention is
 * dark objects). Our masks are white product on black background, so the calls
 * below are intentionally swapped. mask.test.ts pins this behavior.
 */

/** Shrink the product region by px pixels (binary erosion of the white area). */
export async function erode(mask: RawMask, px: number): Promise<RawMask> {
  if (px <= 0) {
    return thresholdMask(mask);
  }
  const data = await maskToSharp(mask)
    .threshold(BINARY_THRESHOLD)
    .dilate(px)
    .toColourspace("b-w")
    .raw()
    .toBuffer();
  return { data, width: mask.width, height: mask.height };
}

/** Grow the product region by px pixels (binary dilation of the white area). */
export async function dilate(mask: RawMask, px: number): Promise<RawMask> {
  if (px <= 0) {
    return thresholdMask(mask);
  }
  const data = await maskToSharp(mask)
    .threshold(BINARY_THRESHOLD)
    .erode(px)
    .toColourspace("b-w")
    .raw()
    .toBuffer();
  return { data, width: mask.width, height: mask.height };
}

/**
 * Soften the mask edge with a Gaussian blur. px is the approximate feather
 * width; the blur sigma is px / 2 clamped to sharp's minimum of 0.3.
 */
export async function feather(mask: RawMask, px: number): Promise<RawMask> {
  if (px <= 0) {
    return mask;
  }
  const sigma = Math.max(0.3, px / 2);
  const data = await maskToSharp(mask).blur(sigma).toColourspace("b-w").raw().toBuffer();
  return { data, width: mask.width, height: mask.height };
}

/** Tight bounding box of pixels above the binary threshold, or null when empty. */
export function boundingBoxOfMask(mask: RawMask, threshold = BINARY_THRESHOLD - 1): BBox | null {
  const { data, width, height } = mask;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (data[row + x] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    return null;
  }
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Share of pixels above the binary threshold, in 0..1. */
export function coverage(mask: RawMask, threshold = BINARY_THRESHOLD - 1): number {
  const { data } = mask;
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > threshold) {
      count++;
    }
  }
  return count / data.length;
}

/** Binarize a mask in pure JS: values at or above the threshold become 255. */
export function thresholdMask(mask: RawMask, threshold = BINARY_THRESHOLD): RawMask {
  const out = Buffer.alloc(mask.data.length);
  for (let i = 0; i < mask.data.length; i++) {
    out[i] = mask.data[i] >= threshold ? 255 : 0;
  }
  return { data: out, width: mask.width, height: mask.height };
}

/** Binarize treating ANY nonzero value as product. Used after resampling. */
export function nonZeroMask(mask: RawMask): RawMask {
  return thresholdMask(mask, 1);
}
