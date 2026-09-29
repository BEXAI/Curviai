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

/** Seller copy for a file whose type a pack cannot use (CLAUDE.md rule 9). */
export const UNSUPPORTED_PHOTO_COPY = "This file type is not supported. Use a JPEG, PNG, WEBP, GIF or TIFF photo.";
export const UNSUPPORTED_VIDEO_COPY = "This video type is not supported. Use an MP4 or MOV video.";
export const UNSUPPORTED_FILE_COPY =
  "This file type is not supported. Use a JPEG, PNG, WEBP, GIF or TIFF photo, or an MP4 or MOV video.";
export const EMPTY_FILE_COPY = "This file is empty. Pick the photo again.";

export function validateUploadRequest(input: UploadSignInput): UploadValidation {
  const allowed: readonly string[] =
    input.kind === "image" ? ALLOWED_IMAGE_CONTENT_TYPES : ALLOWED_VIDEO_CONTENT_TYPES;
  if (!allowed.includes(input.contentType)) {
    return { ok: false, reason: input.kind === "image" ? UNSUPPORTED_PHOTO_COPY : UNSUPPORTED_VIDEO_COPY };
  }
  const maxBytes = input.kind === "image" ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
  if (!Number.isFinite(input.bytes) || input.bytes <= 0) {
    return { ok: false, reason: EMPTY_FILE_COPY };
  }
  if (input.bytes > maxBytes) {
    const cap = input.kind === "image" ? "25 MB" : "200 MB";
    return { ok: false, reason: `File is too large. The ${input.kind} limit is ${cap}.` };
  }
  return { ok: true };
}

/** File extensions browsers sometimes send with an empty type (drag and
 * drop from some apps, some platforms), mapped to the type storage expects. */
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  tif: "image/tiff",
  tiff: "image/tiff",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  qt: "video/quicktime",
};

export type UploadTypeResult = { ok: true; kind: UploadKind; contentType: string } | { ok: false; message: string };

/**
 * The kind and content type to sign for a file picked or dropped in the
 * browser, before any request. Drag and drop skips the input's accept list,
 * so the type is checked here: an empty type is read from the extension, and
 * a type a pack cannot use (HEIC, PDF) gets plain copy instead of a round
 * trip. `allowVideo` is false where only photos fit (logo, add a photo).
 */
export function uploadTypeForFile(
  file: { name: string; type: string },
  options: { allowVideo?: boolean; allowedImageTypes?: readonly string[] } = {},
): UploadTypeResult {
  const allowVideo = options.allowVideo ?? true;
  const images: readonly string[] = options.allowedImageTypes ?? ALLOWED_IMAGE_CONTENT_TYPES;
  const videos: readonly string[] = allowVideo ? ALLOWED_VIDEO_CONTENT_TYPES : [];
  let type = file.type.trim().toLowerCase();
  if (type === "image/jpg" || type === "image/pjpeg") {
    type = "image/jpeg";
  }
  if (type === "") {
    const dot = file.name.lastIndexOf(".");
    type = dot >= 0 ? (EXTENSION_CONTENT_TYPES[file.name.slice(dot + 1).toLowerCase()] ?? "") : "";
  }
  if (images.includes(type)) {
    return { ok: true, kind: "image", contentType: type };
  }
  if (videos.includes(type)) {
    return { ok: true, kind: "video", contentType: type };
  }
  return { ok: false, message: allowVideo ? UNSUPPORTED_FILE_COPY : UNSUPPORTED_PHOTO_COPY };
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
