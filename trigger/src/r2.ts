/**
 * R2 uploads for delivered pack outputs (plan 4.1 storage layer). The worker
 * uploads loose files, channel zips and the compliance report to the private
 * bucket under ws/{workspaceId}/jobs/{jobId}/; the web app serves them through
 * short lived signed GET urls. Returns null when R2 env is absent so demo and
 * test runs skip persistence instead of failing.
 */

import { readFile } from "node:fs/promises";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { PackFileHandoff } from "./pipeline-runner";
import { optionalEnv } from "./runtime";

/**
 * Socket timeouts for every R2 client in the worker: connecting may take at
 * most 10 s, and a socket idle for 60 s (a half open connection) fails the
 * request instead of hanging it forever. Transfers that keep moving are never
 * cut off.
 */
export const R2_REQUEST_TIMEOUTS = { connectionTimeout: 10_000, requestTimeout: 60_000 } as const;

export interface PackUploader {
  bucket: string;
  upload(localPath: string, key: string): Promise<{ bytes: number }>;
}

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  tif: "image/tiff",
  tiff: "image/tiff",
  mp4: "video/mp4",
  zip: "application/zip",
  json: "application/json",
  pdf: "application/pdf",
};

export function contentTypeFor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export function buildR2Uploader(): PackUploader | null {
  const accountId = optionalEnv("R2_ACCOUNT_ID");
  const accessKeyId = optionalEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = optionalEnv("R2_SECRET_ACCESS_KEY");
  if (!accountId || !accessKeyId || !secretAccessKey) {
    return null;
  }
  const bucket = optionalEnv("R2_BUCKET_PRIVATE") ?? "curvi-private";
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    // A stalled socket to R2 fails instead of hanging the shot, and with it
    // the process wide queue kept photo shots wait in.
    requestHandler: R2_REQUEST_TIMEOUTS,
  });
  return {
    bucket,
    async upload(localPath: string, key: string): Promise<{ bytes: number }> {
      const body = await readFile(localPath);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentTypeFor(key),
        }),
      );
      return { bytes: body.length };
    },
  };
}

/**
 * The R2 handoff for delivered files too large to cross the generate-shot
 * subtask boundary inline (PHASE_15 item 15), in the private bucket. Null
 * when R2 env is absent; every file then stays inline.
 */
export function buildR2Handoff(): PackFileHandoff | null {
  const accountId = optionalEnv("R2_ACCOUNT_ID");
  const accessKeyId = optionalEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = optionalEnv("R2_SECRET_ACCESS_KEY");
  if (!accountId || !accessKeyId || !secretAccessKey) {
    return null;
  }
  const bucket = optionalEnv("R2_BUCKET_PRIVATE") ?? "curvi-private";
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    // A stalled socket to R2 fails instead of hanging the shot, and with it
    // the process wide queue kept photo shots wait in.
    requestHandler: R2_REQUEST_TIMEOUTS,
  });
  return {
    async put(key, bytes, contentType) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }));
    },
    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const body = await res.Body?.transformToByteArray();
        return body ? Buffer.from(body) : null;
      } catch {
        return null;
      }
    },
  };
}

export function packFileKey(workspaceId: string, jobId: string, filename: string): string {
  return `ws/${workspaceId}/jobs/${jobId}/pack/${filename}`;
}

export function assetFileKey(
  workspaceId: string,
  jobId: string,
  channel: string,
  filename: string,
): string {
  return `ws/${workspaceId}/jobs/${jobId}/files/${channel}/${filename}`;
}

/** Key of a file a pack follow up delivers (a retried shot or an added
 * angle). The run key keeps it apart from every file already delivered, so a
 * follow up can never overwrite one, whatever name the channel convention
 * gives it. */
export function followUpFileKey(
  workspaceId: string,
  jobId: string,
  runKey: string,
  channel: string,
  filename: string,
): string {
  return `ws/${workspaceId}/jobs/${jobId}/files/${channel}/followup-${runKey}/${filename}`;
}
