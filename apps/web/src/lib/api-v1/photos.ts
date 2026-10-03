/**
 * Photos sent to the public API: a public link, fetched through the SSRF
 * safe fetch exactly as a product link import is (lib/url-import/image), or
 * base64 bytes checked the same way (allowed type proven by magic bytes,
 * the 25 MB cap and the 80 megapixel cap). Stored photos land under the
 * workspace's source prefix, named after their sha256 plus a fresh request
 * suffix. The immutable request fingerprint uses the original photo hashes,
 * so retries replay even though each attempt owns different objects.
 * The pack's server side
 * ingest then checks each photo again, as it does a browser upload, and
 * writes the cleaned bytes back to the same key. A photo is therefore only
 * written when its key is empty (putSourceObjectIfAbsent). One request can
 * never delete or write raw EXIF back over another request's cleaned copy.
 *
 * Photos attached in ChatGPT (PHASE_19 P19-15) arrive as OpenAI's file
 * object, { download_url, file_id, mime_type?, file_name? }
 * (docs/verification.md, "PHASE_19: ChatGPT and Codex plugin", O2). Only
 * download_url is read, through the same SSRF safe import as a photo link,
 * so a link that resolves to a private address is refused like any other.
 * The type comes from the bytes, never from mime_type or file_name, and
 * neither download_url nor file_id is stored or logged: the stored key is
 * named after the bytes. A refusal for an attachment uses the neutral MCP
 * copy (mcp-copy.ts), which has no web form words.
 *
 * A set of photos is read three at a time under one 30 second deadline for
 * the whole set (it was up to six reads one after another, 15 seconds
 * each), and the request's order and de-duplication are kept.
 */

import { createHash, randomUUID } from "node:crypto";
import { apiSourceKey, putSourceObjectIfAbsent } from "@/lib/r2";
import { r2TrustStorage } from "@/lib/trust/storage";
import { IMAGE_MAX_BYTES, PIXEL_CAP_MEGAPIXELS, withinPixelCap } from "@/lib/upload-validation";
import {
  imageDimensions,
  importPhoto,
  isHeic,
  sniffImageType,
  type ImportedPhoto,
  type PhotoImportResult,
} from "@/lib/url-import/image";
import type { PhotoAngle } from "@/lib/services/types";
import { MCP_COPY } from "./mcp-copy";

export type PhotoFailureReason = Extract<PhotoImportResult, { ok: false }>["reason"];
type PhotoFailure = Extract<PhotoImportResult, { ok: false }>;

export const PHOTO_FAILURE_STATUS: Record<PhotoFailureReason, number> = {
  invalid_url: 400,
  blocked_host: 400,
  not_image: 422,
  too_large: 422,
  timeout: 504,
  unreachable: 502,
};

/** Photos of one request read at the same time. */
export const PACK_PHOTO_FETCH_CONCURRENCY = 3;

/** One deadline for reading every photo of a request. */
export const PACK_PHOTO_SET_DEADLINE_MS = 30_000;

/** The refusal when a chat attachment did not come through (the file
 * argument is missing or a placeholder), and the line for a request that
 * sends both kinds of photo. */
export const NO_ATTACHMENT = {
  status: 400,
  reason: "no_attachment",
  message: MCP_COPY.noAttachment,
  bothSources: MCP_COPY.photoSourcesBoth,
} as const;

const DATA_COPY = {
  not_base64: "A photo's data is not base64. Send the file bytes base64 encoded.",
  not_image: "A photo is not a JPEG, PNG, WEBP, GIF or TIFF image.",
  too_large: "A photo is over 25 MB. Send a smaller one.",
  pixels: `A photo is over ${PIXEL_CAP_MEGAPIXELS} megapixels. Send a smaller one.`,
  unreadable: "We could not read the size of a photo. Send it as JPEG or PNG.",
} as const;

/** The public API's line when the set's deadline passes during a read. */
const SET_TIMEOUT_COPY = "Reading the photos took too long. Try again, or send fewer or smaller photos.";

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
    return { ok: false, reason: "not_image", message: DATA_COPY.not_image, ...(isHeic(body) ? { format: "heic" as const } : {}) };
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

/** A ChatGPT attachment, as far as Curvi reads it: the link only. */
export interface AttachedFile {
  download_url: string;
}

/**
 * One photo of a request: a link (url), base64 bytes (data), or a ChatGPT
 * attachment. An element of create_pack's images is itself an attachment
 * (download_url); check_main_image's single attachment arrives as image.
 * Other fields of OpenAI's file object (file_id, mime_type, file_name) are
 * never read.
 */
export interface PhotoSource {
  url?: string;
  data?: string;
  download_url?: string;
  image?: AttachedFile;
}

/** One photo of a pack request, with what it shows when not the front. */
export type PackPhotoSource = PhotoSource & { angle?: PhotoAngle };

/** Who reads a photo refusal: "api" keeps the public API's copy, and
 * "assistant" is the neutral MCP copy, without web form words. A chat
 * attachment always gets the assistant copy. */
export type PhotoCopyAudience = "api" | "assistant";

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

export interface ReadPhotoOptions {
  /** The photo's place in the request, counted from 1, for the copy. */
  number?: number;
  audience?: PhotoCopyAudience;
  /** The longest a link fetch may take, in milliseconds. */
  timeoutMs?: number;
}

/** The attachment link of a photo, or null when it is not an attachment. */
export function attachmentLinkOf(source: PhotoSource): string | null {
  if (source.download_url !== undefined) {
    return source.download_url;
  }
  return source.image !== undefined ? source.image.download_url : null;
}

function audienceOf(source: PhotoSource, audience: PhotoCopyAudience | undefined): PhotoCopyAudience {
  return attachmentLinkOf(source) !== null ? "assistant" : (audience ?? "api");
}

/** The neutral MCP line for a photo that could not be read. */
export function assistantPhotoMessage(failure: Pick<PhotoFailure, "reason" | "format">, photoNumber: number): string {
  if (failure.format === "heic") {
    return MCP_COPY.heic;
  }
  switch (failure.reason) {
    case "not_image":
      return MCP_COPY.photoUnreadable(photoNumber);
    case "too_large":
      return MCP_COPY.photoTooLarge(photoNumber);
    case "timeout":
      return MCP_COPY.photoTimeout(photoNumber);
    case "invalid_url":
    case "blocked_host":
    case "unreachable":
      return MCP_COPY.photoNotDownloaded(photoNumber);
  }
}

/** Reads one photo from a link, an attachment or base64. A refusal for an
 * attachment (or for the assistant audience) carries the neutral MCP copy;
 * otherwise the public API's copy, as before. */
export async function readPhoto(
  source: PhotoSource,
  deps: PhotoDeps = {},
  options: ReadPhotoOptions = {},
): Promise<PhotoImportResult> {
  const link = attachmentLinkOf(source);
  let read: PhotoImportResult;
  if (link === null && source.data !== undefined) {
    read = photoFromBase64(source.data);
  } else {
    const url = link ?? source.url ?? "";
    read = deps.fetchPhoto
      ? await deps.fetchPhoto(url)
      : await importPhoto(url, options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {});
  }
  if (read.ok || audienceOf(source, options.audience) === "api") {
    return read;
  }
  return { ...read, message: assistantPhotoMessage(read, options.number ?? 1) };
}

/**
 * True when a file argument carries no usable attachment: absent, null, a
 * placeholder string a model wrote in place of the file, an empty list, or
 * an entry without a download_url that is an absolute URL. ChatGPT
 * sometimes calls a tool without the file the user attached
 * (docs/phases/PHASE_19.md, "Still unverified"); the caller answers with
 * MCP_COPY.noAttachment instead of a schema error.
 */
export function attachmentMissing(value: unknown): boolean {
  if (value === undefined || value === null || typeof value !== "object") {
    return true;
  }
  const entries: unknown[] = Array.isArray(value) ? value : [value];
  return (
    entries.length === 0 ||
    entries.some((entry) => {
      const link = entry && typeof entry === "object" ? (entry as { download_url?: unknown }).download_url : undefined;
      return typeof link !== "string" || !URL.canParse(link);
    })
  );
}

/** True when a request body names the attachment field but nothing usable
 * came through in it (attachmentMissing). */
export function missingAttachmentIn(body: unknown, field: "images" | "image"): boolean {
  return (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.hasOwn(body, field) &&
    attachmentMissing((body as Record<string, unknown>)[field])
  );
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

type SetFailure = Extract<StorePhotosResult, { ok: false }>;

export interface PhotoSetOptions extends PhotoDeps {
  /** The copy for refusals of link and base64 photos (attachments always
   * get the assistant copy). Defaults to "api". */
  audience?: PhotoCopyAudience;
  /** One deadline for reading the whole set. Defaults to
   * PACK_PHOTO_SET_DEADLINE_MS. */
  deadlineMs?: number;
}

/**
 * Runs fn over the items, at most `limit` at a time, starting them in
 * order, and starts no new item once stop() is true. Results are by index;
 * an item that never started is undefined.
 */
async function eachLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  stop: () => boolean,
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array<R | undefined>(items.length).fill(undefined);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && !stop()) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(0, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Reads one photo of a set before the set's deadline: whatever the fetch
 * does, the read answers by then. */
async function readBefore(
  source: PhotoSource,
  index: number,
  deadlineAt: number,
  options: PhotoSetOptions,
): Promise<PhotoImportResult> {
  const audience = audienceOf(source, options.audience);
  const timedOut: PhotoImportResult = {
    ok: false,
    reason: "timeout",
    message: audience === "assistant" ? MCP_COPY.photoTimeout(index + 1) : SET_TIMEOUT_COPY,
  };
  const left = deadlineAt - Date.now();
  if (left <= 0) {
    return timedOut;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<PhotoImportResult>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), left);
  });
  try {
    return await Promise.race([
      readPhoto(source, options, { number: index + 1, audience, timeoutMs: left }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function setFailure(read: PhotoFailure, index: number, source: PhotoSource, audience: PhotoCopyAudience | undefined): SetFailure {
  return {
    ok: false,
    status: PHOTO_FAILURE_STATUS[read.reason],
    reason: read.reason,
    // The assistant copy names the photo already.
    message: audienceOf(source, audience) === "assistant" ? read.message : `Photo ${index + 1}: ${read.message}`,
  };
}

const STORAGE_FAILURE: SetFailure = {
  ok: false,
  status: 503,
  reason: "storage",
  message: "We could not save a photo. Try again in a moment.",
};

/**
 * Reads each photo and, when store is true, writes it to the workspace's
 * source prefix. With store false (the in memory demo, which keeps no
 * files) the photo is still read and checked with the same request-owned
 * keys and logical hashes, so a demo replay behaves as production does.
 *
 * Photos are read PACK_PHOTO_FETCH_CONCURRENCY at a time under one
 * deadline. The first refusal in the request's order is answered, no new
 * read starts after a refusal, and every photo this call wrote is taken back.
 * Uploads keep the request's order; the same photo twice is one photo, with
 * the first one's angle.
 */
export async function storePackPhotos(
  workspaceId: string,
  photos: readonly PackPhotoSource[],
  options: { store: boolean } & PhotoSetOptions,
): Promise<StorePhotosResult> {
  const deadlineAt = Date.now() + (options.deadlineMs ?? PACK_PHOTO_SET_DEADLINE_MS);
  const put = options.put ?? ((ws, photo, k) => putSourceObjectIfAbsent(ws, photo.body, photo.contentType, k));
  // Cleanup may only remove this attempt's objects. Content-addressed keys
  // shared across requests let a refused request delete another pack's
  // source, and can attach two new products' photos to only the first one.
  // Keep the hash for logical replay and dedupe within this attempt only.
  const attempt = randomUUID();
  const claimed = new Set<string>();
  let refused = false;
  type Slot = { ok: true; key: string; sha256: string; created: boolean } | SetFailure;

  const slots = await eachLimited<PackPhotoSource, Slot>(
    photos,
    PACK_PHOTO_FETCH_CONCURRENCY,
    async (source, index) => {
      const read = await readBefore(source, index, deadlineAt, options);
      if (!read.ok) {
        refused = true;
        return setFailure(read, index, source, options.audience);
      }
      const key = `${apiSourceKey(workspaceId, read.photo.sha256)}-${attempt}`;
      let created = false;
      // The same photo twice is stored once; nothing more is stored once the
      // request is refused.
      if (options.store && !refused && !claimed.has(key)) {
        claimed.add(key);
        try {
          created = await put(workspaceId, read.photo, key);
        } catch (err) {
          refused = true;
          console.error("[api/v1] storing a photo failed", err);
          return STORAGE_FAILURE;
        }
      }
      return { ok: true, key, sha256: read.photo.sha256, created };
    },
    () => refused,
  );

  const created = [...new Set(slots.flatMap((slot) => (slot?.ok && slot.created ? [slot.key] : [])))];
  const failure = slots.find((slot): slot is SetFailure => slot !== undefined && !slot.ok);
  if (failure) {
    await discardStoredPhotos(created, options);
    return failure;
  }
  const uploads: PackUpload[] = [];
  for (const [index, slot] of slots.entries()) {
    if (!slot?.ok || uploads.some((upload) => upload.key === slot.key)) {
      continue;
    }
    const angle = photos[index]?.angle;
    uploads.push({ key: slot.key, sha256: slot.sha256, kind: "image", ...(angle ? { angle } : {}) });
  }
  return { ok: true, uploads, created };
}

/** What a photo is, read without storing it: estimate_pack (PHASE_19 P19-16)
 * needs each photo's hash, size and angle to count credits as createJob will. */
export interface ReadPackPhoto {
  sha256: string;
  width?: number;
  height?: number;
  angle?: PhotoAngle;
}

export type ReadPackPhotosResult = { ok: true; photos: ReadPackPhoto[] } | SetFailure;

/**
 * Reads and checks each photo exactly as storePackPhotos does (the same
 * concurrency, deadline, copy, order and de-duplication) and stores nothing.
 * The bytes are dropped once hashed and sized.
 */
export async function readPackPhotos(
  photos: readonly PackPhotoSource[],
  options: PhotoSetOptions = {},
): Promise<ReadPackPhotosResult> {
  const deadlineAt = Date.now() + (options.deadlineMs ?? PACK_PHOTO_SET_DEADLINE_MS);
  let refused = false;
  type Slot = { ok: true; photo: ReadPackPhoto } | SetFailure;
  const slots = await eachLimited<PackPhotoSource, Slot>(
    photos,
    PACK_PHOTO_FETCH_CONCURRENCY,
    async (source, index) => {
      const read = await readBefore(source, index, deadlineAt, options);
      if (!read.ok) {
        refused = true;
        return setFailure(read, index, source, options.audience);
      }
      const { sha256, width, height } = read.photo;
      return {
        ok: true,
        photo: {
          sha256,
          ...(width !== undefined && height !== undefined ? { width, height } : {}),
          ...(source.angle ? { angle: source.angle } : {}),
        },
      };
    },
    () => refused,
  );
  const failure = slots.find((slot): slot is SetFailure => slot !== undefined && !slot.ok);
  if (failure) {
    return failure;
  }
  const read: ReadPackPhoto[] = [];
  for (const slot of slots) {
    if (slot?.ok && !read.some((photo) => photo.sha256 === slot.photo.sha256)) {
      read.push(slot.photo);
    }
  }
  return { ok: true, photos: read };
}

/**
 * Takes back photos a refused request wrote, so a request refused for its
 * role, plan, credits or product leaves no raw, never ingested bytes under
 * src/. Only this attempt's unique keys are passed in. Best effort; a failure is
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
