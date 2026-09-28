/**
 * Cloudflare R2 presigning through the S3 compatible API. Callers check
 * isR2Configured() before touching this. Source uploads use
 * ws/{workspaceId}/src/{uuid} keys; pack downloads are signed GET urls that
 * expire after 15 minutes, the private asset rule from plan 4.2.3.
 */

import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { optionalEnv, requireEnv } from "@/lib/env";

export const UPLOAD_URL_TTL_SECONDS = 600;
export const DOWNLOAD_URL_TTL_SECONDS = 900;

export function sourceUploadKey(workspaceId: string): string {
  return `ws/${workspaceId}/src/${randomUUID()}`;
}

function r2Client(): S3Client {
  const accountId = requireEnv("R2_ACCOUNT_ID");
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    },
  });
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
  const bucket = optionalEnv("R2_BUCKET_PRIVATE") ?? "curvi-private";
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

/** Signed GET url for a stored object, expiring in 15 minutes. */
export async function presignDownload(key: string): Promise<string> {
  const bucket = optionalEnv("R2_BUCKET_PRIVATE") ?? "curvi-private";
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(r2Client(), command, { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
}

/** True when the key sits inside the workspace's source prefix, the only
 * place a client reported upload may point. */
export function isWorkspaceSourceKey(workspaceId: string, key: string): boolean {
  return key.startsWith(`ws/${workspaceId}/src/`) && !key.includes("..");
}

function privateBucket(): string {
  return optionalEnv("R2_BUCKET_PRIVATE") ?? "curvi-private";
}

/** Writes generated output bytes under the workspace's out prefix. */
export async function putGeneratedObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await r2Client().send(
    new PutObjectCommand({ Bucket: privateBucket(), Key: key, Body: body, ContentType: contentType }),
  );
}

/** Signed GET for rendering and downloading generated assets. An hour keeps
 * an open job board or brand page working without a refresh. */
export async function presignObjectGet(key: string, expiresIn = 3600): Promise<string> {
  return getSignedUrl(r2Client(), new GetObjectCommand({ Bucket: privateBucket(), Key: key }), { expiresIn });
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
