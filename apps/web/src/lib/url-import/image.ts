/**
 * Fetches one product photo a seller picked from an imported listing and
 * checks it the way an upload is checked: an allowed image type proven by
 * its magic bytes (the Content-Type header is ignored), the 25 MB image cap
 * and the 80 megapixel cap. The bytes then go to R2 under the workspace's
 * source prefix, the same place a browser upload lands.
 */

import { createHash } from "node:crypto";
import {
  ALLOWED_IMAGE_CONTENT_TYPES,
  IMAGE_MAX_BYTES,
  PIXEL_CAP_MEGAPIXELS,
  magicByteCheck,
  withinPixelCap,
} from "@/lib/upload-validation";
import { ImportFetchError, safeFetch } from "./safe-fetch";
import type { ImportFetcher } from "./import-product";

export const IMAGE_FETCH_TIMEOUT_MS = 15_000;

export interface ImportedPhoto {
  body: Buffer;
  contentType: (typeof ALLOWED_IMAGE_CONTENT_TYPES)[number];
  sha256: string;
  width?: number;
  height?: number;
}

export type PhotoImportResult =
  | { ok: true; photo: ImportedPhoto }
  | { ok: false; reason: "invalid_url" | "blocked_host" | "not_image" | "too_large" | "timeout" | "unreachable"; message: string };

const MESSAGES = {
  invalid_url: "That photo link is not one we can use. Pick another photo, or add one with Choose a file.",
  blocked_host: "That photo link does not point to a public site. Pick another photo, or add one with Choose a file.",
  not_image: "That link is not a JPEG, PNG, WEBP, GIF or TIFF photo. Pick another photo.",
  too_large: "That photo is over 25 MB. Pick another photo, or add a smaller one with Choose a file.",
  pixels: `That photo is over ${PIXEL_CAP_MEGAPIXELS} megapixels. Pick another photo, or add a smaller one.`,
  unreadable: "We could not read the size of that photo. Pick another photo, or add it with Choose a file.",
  timeout: "The store took too long to send that photo. Try again.",
  unreachable: "We could not download that photo. Try again, or add it with Choose a file.",
} as const;

/** The image type the bytes prove, or null. */
export function sniffImageType(body: Uint8Array): ImportedPhoto["contentType"] | null {
  return ALLOWED_IMAGE_CONTENT_TYPES.find((type) => magicByteCheck(body, type)) ?? null;
}

function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 <= buf.length) {
    if (buf[offset] !== 0xff) {
      return null;
    }
    const marker = buf[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Start of frame markers carry the size; C4, C8 and CC are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    offset += 2 + buf.readUInt16BE(offset + 2);
  }
  return null;
}

/** Width and height from the image header, or null when it cannot be read
 * (TIFF, or a truncated header). */
export function imageDimensions(
  body: Buffer,
  type: ImportedPhoto["contentType"],
): { width: number; height: number } | null {
  try {
    switch (type) {
      case "image/png":
        return body.length >= 24 && body.toString("latin1", 12, 16) === "IHDR"
          ? { width: body.readUInt32BE(16), height: body.readUInt32BE(20) }
          : null;
      case "image/gif":
        return body.length >= 10 ? { width: body.readUInt16LE(6), height: body.readUInt16LE(8) } : null;
      case "image/webp": {
        const chunk = body.toString("latin1", 12, 16);
        if (chunk === "VP8 " && body.length >= 30) {
          return { width: body.readUInt16LE(26) & 0x3fff, height: body.readUInt16LE(28) & 0x3fff };
        }
        if (chunk === "VP8L" && body.length >= 25) {
          const b0 = body[21] ?? 0;
          const b1 = body[22] ?? 0;
          const b2 = body[23] ?? 0;
          const b3 = body[24] ?? 0;
          return {
            width: 1 + (((b1 & 0x3f) << 8) | b0),
            height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
          };
        }
        if (chunk === "VP8X" && body.length >= 30) {
          return { width: 1 + body.readUIntLE(24, 3), height: 1 + body.readUIntLE(27, 3) };
        }
        return null;
      }
      case "image/jpeg":
        return jpegDimensions(body);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export async function importPhoto(rawUrl: string, deps: { fetcher?: ImportFetcher } = {}): Promise<PhotoImportResult> {
  const fetcher = deps.fetcher ?? safeFetch;
  let body: Buffer;
  try {
    const response = await fetcher(rawUrl, {
      // No AVIF: Shopify's CDN picks the format from Accept, and AVIF is not
      // an upload type we take.
      accept: "image/jpeg,image/png,image/webp,image/gif;q=0.9,image/tiff;q=0.5",
      maxBytes: IMAGE_MAX_BYTES,
      timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
    });
    if (response.status !== 200) {
      return { ok: false, reason: "unreachable", message: MESSAGES.unreachable };
    }
    body = response.body;
  } catch (err) {
    const reason = err instanceof ImportFetchError ? err.reason : "network";
    switch (reason) {
      case "invalid_url":
      case "blocked_host":
      case "too_large":
      case "timeout":
        return { ok: false, reason, message: MESSAGES[reason] };
      default:
        return { ok: false, reason: "unreachable", message: MESSAGES.unreachable };
    }
  }

  const contentType = sniffImageType(body);
  if (!contentType) {
    return { ok: false, reason: "not_image", message: MESSAGES.not_image };
  }
  const size = imageDimensions(body, contentType);
  const readable = size !== null && size.width > 0 && size.height > 0;
  // A header we cannot size could hide any pixel count, so only TIFF (whose
  // header this module does not parse) goes on unsized; server side ingest
  // reads it with sharp and applies the same cap before any decode.
  if (!readable && contentType !== "image/tiff") {
    return { ok: false, reason: "not_image", message: MESSAGES.unreadable };
  }
  if (size && !withinPixelCap(size.width, size.height)) {
    return { ok: false, reason: "too_large", message: MESSAGES.pixels };
  }
  return {
    ok: true,
    photo: {
      body,
      contentType,
      sha256: createHash("sha256").update(body).digest("hex"),
      ...(size && size.width > 0 && size.height > 0 ? { width: size.width, height: size.height } : {}),
    },
  };
}
