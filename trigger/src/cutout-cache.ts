/**
 * A cutout cache in front of every provider that serves the cutout task
 * (docs/phases/PHASE_14.md workstream 4). The preflight at upload cuts the
 * photo out through the same live runtime path a pack uses
 * (LiveShotGenerator.inventoryCutout); this cache keeps the answer in R2 so
 * the pack that follows, and the Trigger.dev shot subtasks that cut the same
 * photo again in other processes, reuse it instead of paying the provider a
 * second time.
 *
 * The key is the workspace plus a sha256 of the exact bytes sent for the
 * cutout (the upright working copy the live runtime prepares), so a hit is
 * always the provider's answer for those very pixels, never another
 * workspace's. A hit younger than CUTOUT_CACHE_FRESH_MS returns the stored
 * bytes at zero cost; anything else calls the provider as before. The
 * wrapper runs inside callWithFailover (packages/ai), so timeouts, retries,
 * failover, breakers and metering are unchanged (CLAUDE.md rule 4); a cache
 * that cannot be read or written never fails the call.
 */

import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Provider, ProviderRegistry, ProviderRequest, ProviderResponse } from "@curvi/ai";
import { CUTOUT_TASK } from "@curvi/pipeline/seed";

/** How long a cached cutout is reused: the preflight's own freshness. */
export const CUTOUT_CACHE_FRESH_MS = 24 * 60 * 60 * 1000;

export interface CachedCutout {
  bytes: Buffer;
  contentType: string;
  storedAt: Date;
}

export interface CutoutCacheStore {
  get(key: string): Promise<CachedCutout | null>;
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
}

/** The cache object key: under the workspace's own prefix, so deleting the
 * workspace's storage deletes it too. */
export function cutoutCacheKey(workspaceId: string, imageBytes: Uint8Array, format = "png"): string {
  const digest = createHash("sha256").update(imageBytes).digest("hex");
  const ext = /^[a-z0-9]{1,8}$/.test(format) ? format : "png";
  return `ws/${workspaceId}/cache/cutout/${digest}.${ext}`;
}

interface CutoutInputShape {
  imageBytes?: unknown;
  format?: unknown;
}

interface CutoutOutputShape {
  imageBytes?: unknown;
  contentType?: unknown;
}

const WRAPPED = new WeakSet<Provider>();

/**
 * Wraps the invoke of every registered provider that serves the task, in
 * place, so provider names, routing, breakers and health probes stay as
 * they are. Returns the names it wrapped; a provider is never wrapped twice.
 */
export function cacheCutouts(
  registry: ProviderRegistry,
  store: CutoutCacheStore,
  opts: { task?: string; freshMs?: number; now?: () => Date } = {},
): string[] {
  const task = opts.task ?? CUTOUT_TASK;
  const freshMs = opts.freshMs ?? CUTOUT_CACHE_FRESH_MS;
  const now = opts.now ?? (() => new Date());
  const wrapped: string[] = [];
  for (const provider of registry.list()) {
    if (!provider.supports(task) || WRAPPED.has(provider)) {
      continue;
    }
    const inner = provider.invoke.bind(provider);
    const cached = async <TIn, TOut>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> => {
      const input = req.input as CutoutInputShape | undefined;
      const bytes = input?.imageBytes;
      if (req.task !== task || !req.workspaceId || !(bytes instanceof Uint8Array)) {
        return inner<TIn, TOut>(req);
      }
      const key = cutoutCacheKey(req.workspaceId, bytes, typeof input?.format === "string" ? input.format : "png");
      const hit = await store.get(key).catch((err: unknown) => {
        console.warn(`[cutout-cache] could not read ${key}`, err instanceof Error ? err.message : err);
        return null;
      });
      if (hit && now().getTime() - hit.storedAt.getTime() < freshMs) {
        return {
          output: { imageBytes: new Uint8Array(hit.bytes), contentType: hit.contentType } as TOut,
          costMicros: 0,
        };
      }
      const response = await inner<TIn, TOut>(req);
      const output = response.output as CutoutOutputShape | undefined;
      if (output?.imageBytes instanceof Uint8Array) {
        const contentType = typeof output.contentType === "string" ? output.contentType : "image/png";
        await store.put(key, Buffer.from(output.imageBytes), contentType).catch((err: unknown) => {
          console.warn(`[cutout-cache] could not store ${key}`, err instanceof Error ? err.message : err);
        });
      }
      return response;
    };
    provider.invoke = cached;
    WRAPPED.add(provider);
    wrapped.push(provider.name);
  }
  return wrapped;
}

type ReadEnv = (name: string) => string | undefined;

const readEnvDefault: ReadEnv = (name) => {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
};

/** The R2 backed store, or null when R2 is not configured. */
export function r2CutoutCacheStore(readEnv: ReadEnv = readEnvDefault): CutoutCacheStore | null {
  const accountId = readEnv("R2_ACCOUNT_ID");
  const accessKeyId = readEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = readEnv("R2_SECRET_ACCESS_KEY");
  if (!accountId || !accessKeyId || !secretAccessKey) {
    return null;
  }
  const bucket = readEnv("R2_BUCKET_PRIVATE") ?? "curvi-private";
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return {
    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const body = await res.Body?.transformToByteArray();
        if (!body || !res.LastModified) {
          return null;
        }
        return { bytes: Buffer.from(body), contentType: res.ContentType ?? "image/png", storedAt: res.LastModified };
      } catch {
        // A missing object is the usual miss.
        return null;
      }
    },
    async put(key, bytes, contentType) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }));
    },
  };
}

/** Puts the R2 cutout cache in front of the registry's cutout providers when
 * R2 is configured; a no op otherwise. */
export function installCutoutCache(registry: ProviderRegistry, readEnv: ReadEnv = readEnvDefault): string[] {
  const store = r2CutoutCacheStore(readEnv);
  return store ? cacheCutouts(registry, store) : [];
}
