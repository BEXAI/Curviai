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

/*
 * Every decoder below applies the EXIF orientation first (sharp's rotate()
 * with no angle), so a phone photo stored sideways with an orientation tag
 * decodes upright, the way viewers and marketplaces show it. Files with no
 * orientation tag, including everything the pipeline encodes itself, decode
 * unchanged. A source and a mask decoded from the same tagged file stay the
 * same size.
 */

/** Decode any sharp readable buffer into raw RGBA, upright per EXIF. */
export async function decodeToRgba(buffer: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(buffer).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: 4 };
}

/** Decode a grayscale mask image (white means product) into a raw mask, upright per EXIF. */
export async function decodeMask(buffer: Buffer): Promise<RawMask> {
  const { data, info } = await sharp(buffer)
    .rotate()
    .toColourspace("b-w")
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 1) {
    throw new Error(`Expected single channel mask, got ${info.channels} channels`);
  }
  return { data, width: info.width, height: info.height };
}

/** Build a mask from the alpha channel of an RGBA image (for cutout PNGs), upright per EXIF. */
export async function maskFromAlpha(buffer: Buffer): Promise<RawMask> {
  const { data, info } = await sharp(buffer)
    .rotate()
    .ensureAlpha()
    .extractChannel("alpha")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export async function encodePng(img: RawImage): Promise<Buffer> {
  return rawToSharp(img).png().toBuffer();
}

/**
 * Re-encodes a photo upright: applies its EXIF orientation to the pixels and
 * drops the tag, so a provider that ignores EXIF (a cutout service, an image
 * model) still sees the product the right way up. Bytes with no orientation
 * tag, or tagged as already upright, come back unchanged. PNG stays PNG;
 * anything else becomes a high quality JPEG.
 */
export async function normalizeOrientation(buffer: Buffer): Promise<Buffer> {
  const meta = await sharp(buffer).metadata();
  if (!meta.orientation || meta.orientation === 1) {
    return buffer;
  }
  const upright = sharp(buffer).rotate();
  return meta.format === "png"
    ? upright.png().toBuffer()
    : upright.jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
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
