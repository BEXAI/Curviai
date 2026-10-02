import sharp from "sharp";
import { ciede2000, rgbToLab } from "../color";
import { erode } from "../mask";
import type { RawImage, RawMask } from "../raw";
import { benchmarkPolicy } from "../seed/growth";
import { deriveQcErodePx } from "./fidelity";

function heatColor(deltaE: number): readonly number[] {
  const ramp = benchmarkPolicy.colorRamp;
  for (let i = 1; i < ramp.length; i += 1) {
    if (deltaE <= ramp[i].deltaE) {
      const lower = ramp[i - 1];
      const upper = ramp[i];
      const fraction = Math.max(0, (deltaE - lower.deltaE) / (upper.deltaE - lower.deltaE));
      return lower.rgb.map((value, channel) => Math.round(value + (upper.rgb[channel] - value) * fraction));
    }
  }
  return ramp[ramp.length - 1].rgb;
}

/** Offline visualization of the exact QC region, after full-size comparison.
 * Reference and shipped must already share the same placement and dimensions.
 * Gray is below deltaE 1; color follows the seeded ramp; excluded pixels are
 * dim gray. This thumbnail cannot substitute for the full-resolution report. */
export async function renderFidelityHeatmap(
  reference: RawImage,
  shipped: RawImage,
  mask: RawMask,
  options: { erodePx?: number } = {},
): Promise<Buffer> {
  const { width, height } = reference;
  const pixels = width * height;
  const erodePx = options.erodePx ?? deriveQcErodePx();
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
    pixels > benchmarkPolicy.maxImagePixels || shipped.width !== width || shipped.height !== height ||
    mask.width !== width || mask.height !== height || reference.data.length !== pixels * 4 ||
    shipped.data.length !== pixels * 4 || mask.data.length !== pixels ||
    !Number.isInteger(erodePx) || erodePx < 0) {
    throw new Error("Heatmap needs valid aligned RGBA images, a matching mask and nonnegative integer erosion.");
  }
  const region = await erode(mask, erodePx);
  if (!region.data.some((value) => value > 0)) throw new Error("Heatmap comparison mask is empty.");
  const data = Buffer.alloc(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    const offset = i * 4;
    const r = reference.data[offset];
    const g = reference.data[offset + 1];
    const b = reference.data[offset + 2];
    const gray = Math.round(r * 0.2126 + g * 0.7152 + b * 0.0722);
    let color: readonly number[] = [gray, gray, gray];
    if (region.data[i] === 0) {
      const dim = Math.round(gray * benchmarkPolicy.backgroundBrightness);
      color = [dim, dim, dim];
    } else {
      const deltaE = ciede2000(rgbToLab(r, g, b), rgbToLab(shipped.data[offset], shipped.data[offset + 1], shipped.data[offset + 2]));
      if (!Number.isFinite(deltaE)) throw new Error("Heatmap encountered a non-finite color difference.");
      if (deltaE >= benchmarkPolicy.unchangedBelowDeltaE) color = heatColor(deltaE);
    }
    for (let channel = 0; channel < 3; channel += 1) data[i * 3 + channel] = color[channel];
  }
  return sharp(data, { raw: { width, height, channels: 3 } })
    .resize({ width: benchmarkPolicy.heatmapMaxSide, height: benchmarkPolicy.heatmapMaxSide, fit: "inside", withoutEnlargement: true })
    .png().toBuffer();
}
