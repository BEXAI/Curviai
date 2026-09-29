import { describe, expect, it } from "vitest";
import { CUTOUT_CACHE_FRESH_MS, cutoutCacheKey, type CachedCutout, type CutoutCacheStore } from "./cutout-cache";
import { hasFreshUploadCutout } from "./live-runtime";

// hasFreshUploadCutout answers whether a pack could cut this photo out from
// the upload's cache alone, which is what lets a pack start while every
// cutout provider is paused.

const WS = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-29T12:00:00Z");

function storeWith(entries: Record<string, Date>): CutoutCacheStore {
  return {
    async get(key): Promise<CachedCutout | null> {
      const storedAt = entries[key];
      return storedAt ? { bytes: Buffer.from("png"), contentType: "image/png", storedAt } : null;
    },
    async put() {},
  };
}

describe("hasFreshUploadCutout", () => {
  // Bytes sharp cannot read are sent as they are, so the key is theirs.
  const source = Buffer.from("not an image the resizer can read");
  const key = cutoutCacheKey(WS, source, "png");

  it("is true for a fresh cached cutout of the same bytes", async () => {
    const store = storeWith({ [key]: new Date(NOW.getTime() - 60_000) });
    expect(await hasFreshUploadCutout(WS, source, { store, now: () => NOW })).toBe(true);
  });

  it("is false once the cached cutout is past the freshness window", async () => {
    const store = storeWith({ [key]: new Date(NOW.getTime() - CUTOUT_CACHE_FRESH_MS - 1) });
    expect(await hasFreshUploadCutout(WS, source, { store, now: () => NOW })).toBe(false);
  });

  it("is false on a miss, for another workspace, and without a store", async () => {
    const store = storeWith({ [key]: NOW });
    expect(await hasFreshUploadCutout(WS, Buffer.from("another photo"), { store, now: () => NOW })).toBe(false);
    expect(
      await hasFreshUploadCutout("00000000-0000-4000-8000-000000000002", source, { store, now: () => NOW }),
    ).toBe(false);
    expect(await hasFreshUploadCutout(WS, source, { store: null })).toBe(false);
  });

  it("answers false when the cache cannot be read", async () => {
    const store: CutoutCacheStore = {
      async get() {
        throw new Error("storage down");
      },
      async put() {},
    };
    expect(await hasFreshUploadCutout(WS, source, { store })).toBe(false);
  });
});
