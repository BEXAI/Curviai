/**
 * Cloudflare R2 presigning through the S3 compatible API. Callers check
 * isR2Configured() before touching this. Source uploads use
 * ws/{workspaceId}/src/{uuid} keys; pack downloads are signed GET urls that
 * expire after 15 minutes, the private asset rule from plan 4.2.3.
 */

import { randomUUID } from "node:crypto";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { optionalEnv, requireEnv } from "@/lib/env";
import { isWorkspaceObjectKey } from "@/lib/object-keys";

export const UPLOAD_URL_TTL_SECONDS = 600;
export const DOWNLOAD_URL_TTL_SECONDS = 900;

export function sourceUploadKey(workspaceId: string): string {
  return `ws/${workspaceId}/src/${randomUUID()}`;
}

/** The source key of a photo sent through the public API: named after its
 * sha256, so the same photo in a retried request lands on the same key. */
export function apiSourceKey(workspaceId: string, sha256: string): string {
  return `ws/${workspaceId}/src/api-${sha256}`;
}

const r2Scope = globalThis as typeof globalThis & { __curviR2Client?: { id: string; client: S3Client } };

/** One S3 client per process, so presigns and object reads reuse its config
 * and its kept alive connections. Rebuilt when the R2 credentials change. */
export function r2Client(): S3Client {
  const accountId = requireEnv("R2_ACCOUNT_ID");
  const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
  const id = `${accountId}\n${accessKeyId}\n${secretAccessKey}`;
  const cached = r2Scope.__curviR2Client;
  if (cached?.id === id) {
    return cached.client;
  }
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    // Connecting to R2 may take at most 10 s, as in the worker. No idle
    // request timeout here: the pack zip route streams objects to the
    // browser, and a slow or paused download must not be cut off.
    requestHandler: { connectionTimeout: 10_000 },
  });
  r2Scope.__curviR2Client = { id, client };
  return client;
}

export interface PresignedUpload {
  url: string;
  key: string;
  bucket: string;
  expiresInSeconds: number;
}

export async function presignSourceUpload(
  workspaceId: string,
  contentType: string,
  contentLength: number,
): Promise<PresignedUpload> {
  const bucket = privateBucket();
  const key = sourceUploadKey(workspaceId);
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
  });
  const url = await getSignedUrl(r2Client(), command, { expiresIn: UPLOAD_URL_TTL_SECONDS });
  return { url, key, bucket, expiresInSeconds: UPLOAD_URL_TTL_SECONDS };
}

/**
 * Content-Disposition value that saves the object under its delivered file
 * name. Browsers ignore the download attribute on cross origin links, so the
 * signed url itself carries the name. The ASCII fallback drops quotes and
 * control characters; filename* carries the exact UTF-8 name.
 */
export function attachmentDisposition(filename: string): string {
  const ascii =
    filename
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "_")
      .trim() || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Signed GET url for a stored object, expiring in 15 minutes. With a file
 * name, the response downloads as an attachment under that name. Links are
 * signed per click by the download route, so an open page never holds a
 * stale one (Update.md 6.6). */
export async function presignDownload(key: string, filename?: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: privateBucket(),
    Key: key,
    ...(filename ? { ResponseContentDisposition: attachmentDisposition(filename) } : {}),
  });
  return getSignedUrl(r2Client(), command, { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
}

/** True when the key sits inside the workspace's source prefix, the only
 * place a client reported upload may point. */
export function isWorkspaceSourceKey(workspaceId: string, key: string): boolean {
  return isWorkspaceObjectKey(workspaceId, key) && key.startsWith(`ws/${workspaceId}/src/`);
}

/** True when the key sits anywhere under the workspace's prefix. Stored keys
 * are re-checked before they are signed or fetched, so a row that points at
 * another tenant's object is never served (Update.md 4.1). */
export function isWorkspaceKey(workspaceId: string, key: string): boolean {
  return isWorkspaceObjectKey(workspaceId, key);
}

export function privateBucket(): string {
  return optionalEnv("R2_BUCKET_PRIVATE") ?? "curvi-private";
}

/** Writes a photo the server fetched for the workspace (a product link
 * import) under the same ws/{workspaceId}/src/ prefix a browser upload
 * uses, and returns its key. The public API passes a key named after the
 * photo's sha256 (apiSourceKey), so a retried request stores the same object
 * under the same key and replays instead of conflicting. */
export async function putSourceObject(
  workspaceId: string,
  body: Buffer,
  contentType: string,
  key: string = sourceUploadKey(workspaceId),
): Promise<string> {
  if (!isWorkspaceSourceKey(workspaceId, key)) {
    throw new Error("putSourceObject: the key is outside the workspace source prefix");
  }
  await r2Client().send(
    new PutObjectCommand({ Bucket: privateBucket(), Key: key, Body: body, ContentType: contentType }),
  );
  return key;
}

/** True for the S3 answer to a conditional write whose precondition
 * failed (412 PreconditionFailed): the object is already there. */
function isPreconditionFailed(err: unknown): boolean {
  const e = err as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  return e?.$metadata?.httpStatusCode === 412 || e?.name === "PreconditionFailed" || e?.Code === "PreconditionFailed";
}

/** Writes a photo under a content addressed source key only when nothing is
 * stored there yet (If-None-Match: *, which R2 supports on PutObject; see
 * docs/verification.md). True when this call created the object, false when
 * it was already there. The public API uses it so a retried request, or a
 * later pack sending the same photo, never puts the raw upload back over
 * the copy ingest already cleaned (EXIF, XMP and IPTC stripped, upright). */
export async function putSourceObjectIfAbsent(
  workspaceId: string,
  body: Buffer,
  contentType: string,
  key: string,
): Promise<boolean> {
  if (!isWorkspaceSourceKey(workspaceId, key)) {
    throw new Error("putSourceObjectIfAbsent: the key is outside the workspace source prefix");
  }
  try {
    await r2Client().send(
      new PutObjectCommand({ Bucket: privateBucket(), Key: key, Body: body, ContentType: contentType, IfNoneMatch: "*" }),
    );
    return true;
  } catch (err) {
    if (isPreconditionFailed(err)) {
      return false;
    }
    throw err;
  }
}

/** Writes generated output bytes under the workspace's out prefix. */
export async function putGeneratedObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await r2Client().send(
    new PutObjectCommand({ Bucket: privateBucket(), Key: key, Body: body, ContentType: contentType }),
  );
}

/** Signing window for preview urls: every request inside one window signs
 * the same url, so a board that polls every two seconds hits the browser
 * cache instead of downloading each thumbnail again. */
export const PREVIEW_SIGNING_WINDOW_SECONDS = 1800;

/** Start of the signing window that contains `now`. */
export function previewSigningDate(now: Date = new Date()): Date {
  const windowMs = PREVIEW_SIGNING_WINDOW_SECONDS * 1000;
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

/** Signed GET for previewing generated assets and logos. The url stays valid
 * for at least `expiresIn` seconds from now (an hour by default), which keeps
 * an open job board or brand page working, and is identical for every call
 * in the same signing window. */
export async function presignObjectGet(key: string, expiresIn = 3600): Promise<string> {
  return getSignedUrl(r2Client(), new GetObjectCommand({ Bucket: privateBucket(), Key: key }), {
    expiresIn: expiresIn + PREVIEW_SIGNING_WINDOW_SECONDS,
    signingDate: previewSigningDate(),
  });
}

/** True when the object exists. Any error, including a missing object,
 * reads as false. */
export async function objectExists(key: string): Promise<boolean> {
  try {
    await r2Client().send(new HeadObjectCommand({ Bucket: privateBucket(), Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Fetches an object's bytes for server side packaging. Null when missing. */
export async function getObjectBytes(key: string): Promise<Buffer | null> {
  try {
    const res = await r2Client().send(new GetObjectCommand({ Bucket: privateBucket(), Key: key }));
    const bytes = await res.Body?.transformToByteArray();
    return bytes ? Buffer.from(bytes) : null;
  } catch {
    return null;
  }
}

/** Bounded metadata read. The abort covers both the GET and its response
 * stream, so callers can safely hold a short database lock while reading. */
export async function getObjectBytesBounded(key: string, maxBytes: number, signal: AbortSignal): Promise<Buffer | null> {
  const response = await r2Client().send(new GetObjectCommand({ Bucket: privateBucket(), Key: key }), { abortSignal: signal });
  if (!response.Body) return null;
  const reader = response.Body.transformToWebStream().getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    if ((response.ContentLength ?? 0) > maxBytes) throw new Error("Stored report exceeds its byte limit.");
    const chunks: Buffer[] = [];
    let length = 0;
    for (;;) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxBytes) throw new Error("Stored report exceeds its byte limit.");
      chunks.push(Buffer.from(part.value));
    }
    return Buffer.concat(chunks, length);
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => undefined);
  }
}
