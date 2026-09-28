/**
 * Cloudflare R2 presigning through the S3 compatible API. Only the sign
 * route touches this, and only after isR2Configured() says the credentials
 * exist. Keys follow the ws/{workspaceId}/src/{uuid} layout from the plan.
 */

import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { optionalEnv, requireEnv } from "@/lib/env";

export const UPLOAD_URL_TTL_SECONDS = 600;

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

function privateBucket(): string {
  return optionalEnv("R2_BUCKET_PRIVATE") ?? "curvi-private";
}

/** Writes generated output bytes under the workspace's out prefix. */
export async function putGeneratedObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await r2Client().send(
    new PutObjectCommand({ Bucket: privateBucket(), Key: key, Body: body, ContentType: contentType }),
  );
}

/** Short lived signed GET for rendering and downloading generated assets. */
export async function presignObjectGet(key: string, expiresIn = 600): Promise<string> {
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
