/**
 * Photos sent to the public API: a public link, fetched through the SSRF
 * safe fetch exactly as a product link import is (lib/url-import/image), or
 * base64 bytes checked the same way (allowed type proven by magic bytes,
 * the 25 MB cap and the 80 megapixel cap). Stored photos land under the
 * workspace's source prefix, named after their sha256 (apiSourceKey), so a
 * retried request sends the same keys and replays. The pack's server side
 * ingest then checks each photo again, as it does a browser upload, and
 * writes the cleaned bytes back to the same key. A photo is therefore only
 * written when its key is empty (putSourceObjectIfAbsent): a retry, or a
 * later pack sending the same photo, never puts the raw upload with its
 * EXIF back over the cleaned copy.
 */

import { createHash } from "node:crypto";
import { apiSourceKey, putSourceObjectIfAbsent } from "@/lib/r2";
import { r2TrustStorage } from "@/lib/trust/storage";
import { IMAGE_MAX_BYTES, PIXEL_CAP_MEGAPIXELS, withinPixelCap } from "@/lib/upload-validation";
import { imageDimensions, importPhoto, sniffImageType, type ImportedPhoto, type PhotoImportResult } from "@/lib/url-import/image";
import type { PhotoAngle } from "@/lib/services/types";

export type PhotoFailureReason = Extract<PhotoImportResult, { ok: false }>["reason"];

export const PHOTO_FAILURE_STATUS: Record<PhotoFailureReason, number> = {
  invalid_url: 400,
  blocked_host: 400,
  not_image: 422,
  too_large: 422,
  timeout: 504,
  unreachable: 502,
};

const DATA_COPY = {
  not_base64: "A photo's data is not base64. Send the file bytes base64 encoded.",
  not_image: "A photo is not a JPEG, PNG, WEBP, GIF or TIFF image.",
  too_large: "A photo is over 25 MB. Send a smaller one.",
  pixels: `A photo is over ${PIXEL_CAP_MEGAPIXELS} megapixels. Send a smaller one.`,
  unreadable: "We could not read the size of a photo. Send it as JPEG or PNG.",
} as const;

const BASE64_PATTERN = /^[A-Za-z0-9+/_-]*={0,2}$/;

/** The bytes of a base64 photo, checked the way an imported photo is. */
export function photoFromBase64(raw: string): PhotoImportResult {
  const payload = raw.replace(/^data:[^,]*;base64,/, "").replace(/\s+/g, "");
  if (!BASE64_PATTERN.test(payload)) {
    return { ok: false, reason: "not_image", message: DATA_COPY.not_base64 };
  }
  const body = Buffer.from(payload, "base64");
  if (body.length === 0) {
    return { ok: false, reason: "not_image", message: DATA_COPY.not_base64 };
  }
  if (body.length > IMAGE_MAX_BYTES) {
    return { ok: false, reason: "too_large", message: DATA_COPY.too_large };
  }
  const contentType = sniffImageType(body);
  if (!contentType) {
    return { ok: false, reason: "not_image", message: DATA_COPY.not_image };
  }
  const size = imageDimensions(body, contentType);
  const readable = size !== null && size.width > 0 && size.height > 0;
  if (!readable && contentType !== "image/tiff") {
    return { ok: false, reason: "not_image", message: DATA_COPY.unreadable };
  }
  if (size && !withinPixelCap(size.width, size.height)) {
    return { ok: false, reason: "too_large", message: DATA_COPY.pixels };
  }
  return {
    ok: true,
    photo: {
      body,
      contentType,
      sha256: createHash("sha256").update(body).digest("hex"),
      ...(readable && size ? { width: size.width, height: size.height } : {}),
    },
  };
}

export interface PhotoSource {
  url?: string;
  data?: string;
}

export interface PhotoDeps {
  /** Fetches a photo link. Defaults to the SSRF safe product photo import. */
  fetchPhoto?: (url: string) => Promise<PhotoImportResult>;
  /** Stores the bytes under the key unless something is already stored
   * there. True when this call created the object. Defaults to R2. */
  put?: (workspaceId: string, photo: ImportedPhoto, key: string) => Promise<boolean>;
  /** Deletes stored photos and returns the keys it could not delete.
   * Defaults to R2. */
  remove?: (keys: string[]) => Promise<string[]>;
}

/** Reads one photo from a link or from base64. */
export async function readPhoto(source: PhotoSource, deps: PhotoDeps = {}): Promise<PhotoImportResult> {
  if (source.data !== undefined) {
    return photoFromBase64(source.data);
  }
  return (deps.fetchPhoto ?? importPhoto)(source.url ?? "");
}

export interface PackUpload {
  key: string;
  sha256: string;
  kind: "image";
  angle?: PhotoAngle;
}

export type StorePhotosResult =
  | {
      ok: true;
      uploads: PackUpload[];
      /** Keys this call wrote (they were empty before), so a refused
       * request can take them back with discardStoredPhotos. */
      created: string[];
    }
  | { ok: false; status: number; reason: string; message: string };

/**
 * Reads each photo and, when store is true, writes it to the workspace's
 * source prefix. With store false (the in memory demo, which keeps no
 * files) the photo is still read and checked, and its key is named the same
 * way, so a demo replay behaves as production does.
 */
export async function storePackPhotos(
  workspaceId: string,
  photos: ReadonlyArray<PhotoSource & { angle?: PhotoAngle }>,
  options: { store: boolean } & PhotoDeps,
): Promise<StorePhotosResult> {
  const uploads: PackUpload[] = [];
  const created: string[] = [];
  const fail = async (result: Extract<StorePhotosResult, { ok: false }>): Promise<StorePhotosResult> => {
    await discardStoredPhotos(created, options);
    return result;
  };
  for (const [index, source] of photos.entries()) {
    const read = await readPhoto(source, options);
    if (!read.ok) {
      return fail({
        ok: false,
        status: PHOTO_FAILURE_STATUS[read.reason],
        reason: read.reason,
        message: `Photo ${index + 1}: ${read.message}`,
      });
    }
    const key = apiSourceKey(workspaceId, read.photo.sha256);
    if (uploads.some((upload) => upload.key === key)) {
      // The same photo twice is one photo.
      continue;
    }
    if (options.store) {
      try {
        const wrote = await (
          options.put ?? ((ws, photo, k) => putSourceObjectIfAbsent(ws, photo.body, photo.contentType, k))
        )(workspaceId, read.photo, key);
        if (wrote) {
          created.push(key);
        }
      } catch (err) {
        console.error("[api/v1] storing a photo failed", err);
        return fail({
          ok: false,
          status: 503,
          reason: "storage",
          message: "We could not save a photo. Try again in a moment.",
        });
      }
    }
    uploads.push({
      key,
      sha256: read.photo.sha256,
      kind: "image",
      ...(source.angle ? { angle: source.angle } : {}),
    });
  }
  return { ok: true, uploads, created };
}

/**
 * Takes back photos a refused request wrote, so a request refused for its
 * role, plan, credits or product leaves no raw, never ingested bytes under
 * src/. Only keys the request itself created are passed in: a key that was
 * already stored belongs to an earlier pack. Best effort; a failure is
 * logged, never thrown.
 */
export async function discardStoredPhotos(keys: readonly string[], deps: PhotoDeps = {}): Promise<void> {
  if (keys.length === 0) {
    return;
  }
  try {
    const failed = await (deps.remove ?? ((k: string[]) => r2TrustStorage().deleteMany(k)))([...keys]);
    if (failed.length > 0) {
      console.warn(`[api/v1] could not delete ${failed.length} photo(s) of a refused request`);
    }
  } catch (err) {
    console.warn("[api/v1] could not delete the photos of a refused request", err);
  }
}
