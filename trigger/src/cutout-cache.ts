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
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { Provider, ProviderRegistry, ProviderRequest, ProviderResponse } from "@curvi/ai";
import { CUTOUT_TASK } from "@curvi/pipeline/seed";
import { optionalEnv, type ReadEnv } from "./env";
import { r2FromEnv } from "./r2";

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
  return `tmp/ws/${workspaceId}/cache/cutout/${digest}.${ext}`;
}

/** Read the new temporary location first, then its pre-migration location.
 * Only builders produce these keys; a missing cache may safely recompute. */
export async function readTemporaryCache(store: CutoutCacheStore, key: string): Promise<CachedCutout | null> {
  const current = await store.get(key).catch(() => null);
  if (current || !key.startsWith("tmp/ws/")) return current;
  return store.get(key.slice(4)).catch(() => null);
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
      const hit = await readTemporaryCache(store, key);
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

/** The R2 backed store, or null when R2 is not configured. */
export function r2CutoutCacheStore(readEnv: ReadEnv = optionalEnv): CutoutCacheStore | null {
  const r2 = r2FromEnv(readEnv);
  if (!r2) {
    return null;
  }
  const { client, bucket } = r2;
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
