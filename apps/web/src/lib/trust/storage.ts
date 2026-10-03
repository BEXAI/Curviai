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

export interface StoredObjectPage {
  objects: StoredObjectInfo[];
  /** Opaque storage cursor, null only when the prefix is exhausted. */
  continuationToken: string | null;
}

export interface PagedTrustStorage extends TrustStorage {
  listPage(prefix: string, limit: number, continuationToken?: string | null): Promise<StoredObjectPage>;
}

/** DeleteObjects takes at most 1000 keys per request. */
const DELETE_BATCH = 1000;
/** Bound metadata/retention operations; streaming downloads keep their own policy. */
const STORAGE_OPERATION_TIMEOUT_MS = 10_000;

export function r2TrustStorage(): PagedTrustStorage {
  const client = r2Client();
  const Bucket = privateBucket();
  return {
    async head(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket, Key: key }), { abortSignal: AbortSignal.timeout(STORAGE_OPERATION_TIMEOUT_MS) });
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
    async listPage(prefix, limit, continuationToken) {
      if (!Number.isInteger(limit) || limit < 1) throw new Error("Storage page size must be positive");
      const res = await client.send(new ListObjectsV2Command({
        Bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken ?? undefined,
        MaxKeys: Math.min(1000, limit),
      }), { abortSignal: AbortSignal.timeout(STORAGE_OPERATION_TIMEOUT_MS) });
      if (res.IsTruncated && !res.NextContinuationToken) throw new Error("Storage returned an incomplete page without a cursor");
      return {
        objects: (res.Contents ?? []).flatMap((item) => item.Key
          ? [{ key: item.Key, bytes: Number(item.Size ?? 0), lastModified: item.LastModified ?? null }]
          : []),
        continuationToken: res.IsTruncated ? res.NextContinuationToken! : null,
      };
    },
    async list(prefix, limit) {
      const found: StoredObjectInfo[] = [];
      let token: string | null = null;
      while (found.length < limit) {
        const page = await this.listPage(prefix, limit - found.length, token);
        found.push(...page.objects);
        if (!page.continuationToken) break;
        if (page.continuationToken === token) throw new Error("Storage cursor did not advance");
        token = page.continuationToken;
      }
      return found;
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
            { abortSignal: AbortSignal.timeout(STORAGE_OPERATION_TIMEOUT_MS) },
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
export class MemoryTrustStorage implements PagedTrustStorage {
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

  async listPage(prefix: string, limit: number, continuationToken?: string | null): Promise<StoredObjectPage> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Storage page size must be positive");
    const remaining = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix) && (!continuationToken || key > continuationToken))
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const page = remaining.slice(0, Math.min(limit, 1000));
    return {
      objects: page.map(([key, value]) => ({ key, bytes: value.body.length, lastModified: value.lastModified })),
      continuationToken: remaining.length > page.length ? page.at(-1)![0] : null,
    };
  }

  async list(prefix: string, limit: number) {
    const found: StoredObjectInfo[] = [];
    let token: string | null = null;
    while (found.length < limit) {
      const page = await this.listPage(prefix, limit - found.length, token);
      found.push(...page.objects);
      if (!page.continuationToken) break;
      token = page.continuationToken;
    }
    return found;
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
