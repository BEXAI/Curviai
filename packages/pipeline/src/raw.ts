/**
 * Raw pixel buffer types shared by the deterministic pipeline. Images are
 * interleaved RGBA, masks are single channel where 255 means product.
 */
import sharp from "sharp";

export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  /** Always 4 (RGBA) for pipeline images. */
  channels: 4;
}

export interface RawMask {
  data: Buffer;
  width: number;
  height: number;
}

export function rawToSharp(img: RawImage): sharp.Sharp {
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } });
}

export function maskToSharp(mask: RawMask): sharp.Sharp {
  return sharp(mask.data, { raw: { width: mask.width, height: mask.height, channels: 1 } });
}

/** Decode any sharp readable buffer into raw RGBA. */
export async function decodeToRgba(buffer: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: 4 };
}

/** Decode a grayscale mask image (white means product) into a raw mask. */
export async function decodeMask(buffer: Buffer): Promise<RawMask> {
  const { data, info } = await sharp(buffer)
    .toColourspace("b-w")
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 1) {
    throw new Error(`Expected single channel mask, got ${info.channels} channels`);
  }
  return { data, width: info.width, height: info.height };
}

/** Build a mask from the alpha channel of an RGBA image (for cutout PNGs). */
export async function maskFromAlpha(buffer: Buffer): Promise<RawMask> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .extractChannel("alpha")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export async function encodePng(img: RawImage): Promise<Buffer> {
  return rawToSharp(img).png().toBuffer();
}

export async function encodeJpeg(img: RawImage, quality = 90): Promise<Buffer> {
  // 4:4:4 keeps chroma blocks small so flat white regions stay exactly white.
  return rawToSharp(img).flatten({ background: "#ffffff" }).jpeg({ quality, chromaSubsampling: "4:4:4" }).toBuffer();
}

/**
 * Downscales and re-encodes a photo for LLM vision input. Uploads may be up
 * to 25 MB while vision APIs cap around 5 MB and gain nothing above roughly
 * 1568 px on the long side, so everything is normalized to a bounded JPEG.
 */
export async function encodeVisionJpeg(bytes: Buffer, maxSide = 1568): Promise<Buffer> {
  return sharp(bytes)
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85 })
    .toBuffer();
}

/** Solid color RGBA canvas. */
export function solidCanvas(width: number, height: number, r: number, g: number, b: number, a = 255): RawImage {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = a;
  }
  return { data, width, height, channels: 4 };
}

export function cloneRaw(img: RawImage): RawImage {
  return { data: Buffer.from(img.data), width: img.width, height: img.height, channels: 4 };
}
