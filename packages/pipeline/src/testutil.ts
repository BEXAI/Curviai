/**
 * Synthetic image builders shared by tests and the eval harness. Everything is
 * generated at runtime with sharp; no binary fixtures are checked in.
 */
import sharp from "sharp";
import type { RawImage, RawMask } from "./raw";

export interface SyntheticProduct {
  /** Encoded source photo (PNG). */
  source: Buffer;
  /** Encoded grayscale mask (PNG), white means product. */
  mask: Buffer;
  width: number;
  height: number;
}

export interface SyntheticOptions {
  size?: number;
  /** Background gray level of the fake photo. Default 240. */
  background?: number;
}

/**
 * Draw a product from an SVG body string. The mask is derived from the same
 * geometry rendered white on black, so mask and product agree exactly.
 */
export async function productFromSvg(
  svgBody: string,
  maskBody: string,
  opts: SyntheticOptions = {},
): Promise<SyntheticProduct> {
  const size = opts.size ?? 256;
  const bg = opts.background ?? 240;
  const sourceSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" fill="rgb(${bg},${bg},${bg})"/>
  ${svgBody}
</svg>`;
  const maskSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" fill="black"/>
  ${maskBody}
</svg>`;
  const source = await sharp(Buffer.from(sourceSvg)).png().toBuffer();
  const mask = await sharp(Buffer.from(maskSvg)).flatten({ background: "#000000" }).greyscale().png().toBuffer();
  return { source, mask, width: size, height: size };
}

/** A simple filled rectangle product, the workhorse test subject. */
export async function rectProduct(
  size = 256,
  fill = "rgb(180,40,40)",
  opts: SyntheticOptions = {},
): Promise<SyntheticProduct> {
  const s = size;
  const x = Math.round(s * 0.3);
  const y = Math.round(s * 0.25);
  const w = Math.round(s * 0.4);
  const h = Math.round(s * 0.5);
  return productFromSvg(
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="white"/>`,
    { size, ...opts },
  );
}

/** Solid RawImage canvas for direct pixel tests. */
export function rawCanvas(width: number, height: number, r: number, g: number, b: number): RawImage {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 255;
  }
  return { data, width, height, channels: 4 };
}

/** Rectangular RawMask. */
export function rectMask(
  width: number,
  height: number,
  box: { left: number; top: number; width: number; height: number },
): RawMask {
  const data = Buffer.alloc(width * height, 0);
  for (let y = box.top; y < box.top + box.height; y++) {
    for (let x = box.left; x < box.left + box.width; x++) {
      data[y * width + x] = 255;
    }
  }
  return { data, width, height };
}

/** Paint a solid rectangle into a RawImage in place. */
export function paintRect(
  img: RawImage,
  box: { left: number; top: number; width: number; height: number },
  r: number,
  g: number,
  b: number,
): void {
  for (let y = box.top; y < box.top + box.height; y++) {
    for (let x = box.left; x < box.left + box.width; x++) {
      const o = (y * img.width + x) * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
}
