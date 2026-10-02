/**
 * Re-encodes an image for a public share page (/s/{slug}). The seller's
 * original photo can carry EXIF such as GPS coordinates and the camera
 * serial, so nothing on a share page is served as stored: every image is
 * decoded, turned upright, flattened on white, bounded in size and written
 * as a fresh JPEG with no metadata at all.
 */
import sharp from "sharp";
import { INGEST_PIXEL_CAP } from "./ingest/image";

/** Longest side of a share page image, in pixels. */
export const SHARE_IMAGE_MAX_SIDE = 1600;

export async function shareImageJpeg(bytes: Buffer, maxSide = SHARE_IMAGE_MAX_SIDE): Promise<Buffer> {
  // sharp drops every metadata block unless withMetadata() or keepExif() is
  // called, and neither is, so the output carries no EXIF, XMP or IPTC.
  // Uploads are capped at 80 megapixels at ingest; the same cap here keeps
  // a stored file that slipped past it from being decoded on a public route.
  return sharp(bytes, { failOn: "none", limitInputPixels: INGEST_PIXEL_CAP })
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}
