/**
 * Cloudflare R2 presigning through the S3 compatible API. Only the sign
 * route touches this, and only after isR2Configured() says the credentials
 * exist. Keys follow the ws/{workspaceId}/src/{uuid} layout from the plan.
 */

import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
