/**
 * The object storage operations the trust features need (upload ingest,
 * account deletion, the 30 day source purge), behind one small interface so
 * each feature can be tested with an in memory store. The R2 implementation
 * uses the S3 compatible API: HeadObject, GetObject with a Range header,
 * PutObject, ListObjectsV2 with a prefix and continuation token, and
 * DeleteObjects with up to 1000 keys per call (Cloudflare R2 S3 API
 * compatibility page, checked 2026-09-28, docs/verification.md).
 */

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { privateBucket, r2Client } from "@/lib/r2";

export interface StoredObjectInfo {
  key: string;
  bytes: number;
  lastModified: Date | null;
}

export interface TrustStorage {
  /** Size of the object, or null when it does not exist. */
  head(key: string): Promise<{ bytes: number } | null>;
  /** Bytes start to endInclusive of the object. */
  getRange(key: string, start: number, endInclusive: number): Promise<Uint8Array>;
  get(key: string): Promise<Buffer>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Every object under the prefix, at most `limit` of them. */
  list(prefix: string, limit: number): Promise<StoredObjectInfo[]>;
  /** Deletes the keys and returns the ones that could not be deleted. */
  deleteMany(keys: string[]): Promise<string[]>;
}

/** DeleteObjects takes at most 1000 keys per request. */
const DELETE_BATCH = 1000;

export function r2TrustStorage(): TrustStorage {
  const client = r2Client();
  const Bucket = privateBucket();
  return {
    async head(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { bytes: Number(res.ContentLength ?? 0) };
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404 || (err as { name?: string }).name === "NotFound") {
          return null;
        }
        throw err;
      }
    },
    async getRange(key, start, endInclusive) {
      const res = await client.send(new GetObjectCommand({ Bucket, Key: key, Range: `bytes=${start}-${endInclusive}` }));
      return (await res.Body?.transformToByteArray()) ?? new Uint8Array();
    },
    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      const bytes = await res.Body?.transformToByteArray();
      return Buffer.from(bytes ?? new Uint8Array());
    },
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async list(prefix, limit) {
      const found: StoredObjectInfo[] = [];
      let token: string | undefined;
      do {
        const res = await client.send(
          new ListObjectsV2Command({
            Bucket,
            Prefix: prefix,
            ContinuationToken: token,
            MaxKeys: Math.min(1000, limit - found.length),
          }),
        );
        for (const item of res.Contents ?? []) {
          if (item.Key) {
            found.push({ key: item.Key, bytes: Number(item.Size ?? 0), lastModified: item.LastModified ?? null });
          }
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token && found.length < limit);
      return found.slice(0, limit);
    },
    async deleteMany(keys) {
      const failed: string[] = [];
      for (let i = 0; i < keys.length; i += DELETE_BATCH) {
        const batch = keys.slice(i, i + DELETE_BATCH);
        try {
          const res = await client.send(
            new DeleteObjectsCommand({
              Bucket,
              Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
            }),
          );
          for (const error of res.Errors ?? []) {
            if (error.Key) {
              failed.push(error.Key);
            }
          }
        } catch (err) {
          console.error(`[storage] a delete batch of ${batch.length} objects failed`, err);
          failed.push(...batch);
        }
      }
      return failed;
    },
  };
}

/** In memory TrustStorage for tests and for the demo flow. */
export class MemoryTrustStorage implements TrustStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string; lastModified: Date }>();
  /** Keys whose delete should fail, to test partial failures. */
  readonly failDeletes = new Set<string>();

  seed(key: string, body: Buffer, lastModified = new Date(), contentType = "application/octet-stream"): void {
    this.objects.set(key, { body, contentType, lastModified });
  }

  async head(key: string) {
    const found = this.objects.get(key);
    return found ? { bytes: found.body.length } : null;
  }

  async getRange(key: string, start: number, endInclusive: number) {
    const found = this.objects.get(key);
    if (!found) {
      throw new Error(`no object ${key}`);
    }
    return new Uint8Array(found.body.subarray(start, endInclusive + 1));
  }

  async get(key: string) {
    const found = this.objects.get(key);
    if (!found) {
      throw new Error(`no object ${key}`);
    }
    return found.body;
  }

  async put(key: string, body: Buffer, contentType: string) {
    this.objects.set(key, { body, contentType, lastModified: new Date() });
  }

  async list(prefix: string, limit: number) {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .slice(0, limit)
      .map(([key, value]) => ({ key, bytes: value.body.length, lastModified: value.lastModified }));
  }

  async deleteMany(keys: string[]) {
    const failed: string[] = [];
    for (const key of keys) {
      if (this.failDeletes.has(key)) {
        failed.push(key);
      } else {
        this.objects.delete(key);
      }
    }
    return failed;
  }
}
