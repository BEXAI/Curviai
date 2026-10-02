/**
 * Reads a photo as opaque RGBA pixels for a server side check, such as the
 * Amazon main image checker behind the public API (PHASE_16 workstream 5).
 * The photo is turned upright, bounded in size and flattened on pure white,
 * the way the browser checker draws it on a white canvas, so transparent
 * pixels read as white. Only reads pixels; it never writes an image.
 */
import sharp from "sharp";
import { INGEST_PIXEL_CAP } from "./ingest/image";

/** Longest side the pixels are read at; the natural size is still reported. */
export const CHECK_PIXELS_MAX_SIDE = 1000;

export interface FlatPixels {
  /** RGBA, 4 bytes per pixel, every alpha 255. */
  data: Uint8Array;
  /** Size of the pixel buffer. */
  width: number;
  height: number;
  /** The photo's own upright size. */
  naturalWidth: number;
  naturalHeight: number;
}

/** Decodes the photo, or throws when sharp cannot read it. */
export async function flatPixelsOnWhite(bytes: Uint8Array, maxSide = CHECK_PIXELS_MAX_SIDE): Promise<FlatPixels> {
  const input = sharp(Buffer.from(bytes), { failOn: "none", limitInputPixels: INGEST_PIXEL_CAP });
  const meta = await input.metadata();
  if (!meta.width || !meta.height) {
    throw new Error("unreadable image");
  }
  // EXIF orientations 5 to 8 swap the sides once the photo is upright.
  const swapped = (meta.orientation ?? 1) >= 5;
  const naturalWidth = swapped ? meta.height : meta.width;
  const naturalHeight = swapped ? meta.width : meta.height;
  const { data, info } = await input
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
    naturalWidth,
    naturalHeight,
  };
}
