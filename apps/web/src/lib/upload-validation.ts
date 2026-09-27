/**
 * Pure upload validators for CURVI_BUILD_PLAN.md sections 4.4 and 4.5:
 * 25 MB image and 200 MB video caps, allowed content types, magic byte
 * checks, the 80 megapixel cap and the 60 second video duration cap.
 * Everything here is side effect free so the route handler and unit tests
 * share one source of truth.
 */

export type UploadKind = "image" | "video";

export const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 200 * 1024 * 1024;

/** Uploads above 80 megapixels are rejected before any pipeline work. */
export const PIXEL_CAP_MEGAPIXELS = 80;

/** Source video is capped at 60 seconds; frames are extracted downstream. */
export const VIDEO_MAX_SECONDS = 60;

export const ALLOWED_IMAGE_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/tiff",
] as const;

export const ALLOWED_VIDEO_CONTENT_TYPES = ["video/mp4", "video/quicktime"] as const;

export interface UploadSignInput {
  kind: UploadKind;
  contentType: string;
  bytes: number;
}

export type UploadValidation = { ok: true } | { ok: false; reason: string };

export function validateUploadRequest(input: UploadSignInput): UploadValidation {
  const allowed: readonly string[] =
    input.kind === "image" ? ALLOWED_IMAGE_CONTENT_TYPES : ALLOWED_VIDEO_CONTENT_TYPES;
  if (!allowed.includes(input.contentType)) {
    return {
      ok: false,
      reason: `Content type ${input.contentType} is not allowed for ${input.kind} uploads. Allowed: ${allowed.join(", ")}.`,
    };
  }
  const maxBytes = input.kind === "image" ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
  if (!Number.isFinite(input.bytes) || input.bytes <= 0) {
    return { ok: false, reason: "Upload size must be a positive number of bytes." };
  }
  if (input.bytes > maxBytes) {
    const cap = input.kind === "image" ? "25 MB" : "200 MB";
    return { ok: false, reason: `File is too large. The ${input.kind} limit is ${cap}.` };
  }
  return { ok: true };
}

/** True when width times height stays at or under the 80 megapixel cap. */
export function withinPixelCap(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return false;
  }
  return width * height <= PIXEL_CAP_MEGAPIXELS * 1_000_000;
}

/** True when the measured duration respects the 60 second source video cap. */
export function withinVideoDurationCap(seconds: number): boolean {
  return Number.isFinite(seconds) && seconds > 0 && seconds <= VIDEO_MAX_SECONDS;
}

function ascii(buffer: Uint8Array, offset: number, text: string): boolean {
  if (buffer.length < offset + text.length) {
    return false;
  }
  for (let i = 0; i < text.length; i++) {
    if (buffer[offset + i] !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

function bytesAt(buffer: Uint8Array, offset: number, expected: number[]): boolean {
  if (buffer.length < offset + expected.length) {
    return false;
  }
  return expected.every((value, i) => buffer[offset + i] === value);
}

const QUICKTIME_TOP_LEVEL_ATOMS = ["moov", "mdat", "free", "wide", "skip", "pnot"];

/**
 * Checks the leading bytes of an upload against the claimed content type.
 * Supported: jpeg, png, webp, gif, tiff, mp4 and mov. Unknown claimed types
 * always fail closed.
 */
export function magicByteCheck(buffer: Uint8Array, claimedType: string): boolean {
  switch (claimedType) {
    case "image/jpeg":
      return bytesAt(buffer, 0, [0xff, 0xd8, 0xff]);
    case "image/png":
      return bytesAt(buffer, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/webp":
      return ascii(buffer, 0, "RIFF") && ascii(buffer, 8, "WEBP");
    case "image/gif":
      return ascii(buffer, 0, "GIF87a") || ascii(buffer, 0, "GIF89a");
    case "image/tiff":
      return bytesAt(buffer, 0, [0x49, 0x49, 0x2a, 0x00]) || bytesAt(buffer, 0, [0x4d, 0x4d, 0x00, 0x2a]);
    case "video/mp4":
      return ascii(buffer, 4, "ftyp");
    case "video/quicktime":
      if (ascii(buffer, 4, "ftyp")) {
        return ascii(buffer, 8, "qt");
      }
      return QUICKTIME_TOP_LEVEL_ATOMS.some((atom) => ascii(buffer, 4, atom));
    default:
      return false;
  }
}
