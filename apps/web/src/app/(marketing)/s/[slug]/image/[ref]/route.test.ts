import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRateLimitStore, RATE_LIMIT_POLICIES, setRateLimitStoreForTests } from "@/lib/rate-limit";

// GET /s/[slug]/image/[ref] is public and streams objects from the private
// bucket, so the glue matters: the IP limit, a 404 for anything not on a
// published page, the private cache header and the in process cache.

const imageKey = vi.hoisted(() => vi.fn<(slug: string, ref: string) => Promise<string | null>>());
const isR2Configured = vi.hoisted(() => vi.fn(() => true));
const getObjectBytes = vi.hoisted(() => vi.fn<(key: string) => Promise<Buffer | null>>());

vi.mock("@/lib/shares", () => ({ getShareStore: () => ({ imageKey }) }));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  isR2Configured,
}));
vi.mock("@/lib/r2", () => ({ getObjectBytes }));

const { GET } = await import("./route");

/** A 1 by 1 PNG, so the real share image encoder runs. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const KEY = "ws/0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d/v/main.png";

function get(ip = "203.0.113.7", slug = "corner-shop", ref = "v_1") {
  const request = new Request(`https://curvi.ai/s/${slug}/image/${ref}`, {
    headers: { "x-forwarded-for": ip },
  });
  return GET(request, { params: Promise.resolve({ slug, ref }) });
}

beforeEach(() => {
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  delete (globalThis as { __curviShareImageCache?: unknown }).__curviShareImageCache;
  imageKey.mockReset().mockResolvedValue(KEY);
  isR2Configured.mockReset().mockReturnValue(true);
  getObjectBytes.mockReset().mockResolvedValue(PNG);
});

afterEach(() => {
  setRateLimitStoreForTests(null);
});

describe("GET /s/[slug]/image/[ref]", () => {
  it("answers 404 without looking up the share when storage is not configured", async () => {
    isR2Configured.mockReturnValue(false);
    const response = await get();
    expect(response.status).toBe(404);
    expect(imageKey).not.toHaveBeenCalled();
  });

  it("answers 404 for an image that is not on a published page", async () => {
    imageKey.mockResolvedValue(null);
    const response = await get();
    expect(response.status).toBe(404);
    expect(imageKey).toHaveBeenCalledWith("corner-shop", "v_1");
    expect(getObjectBytes).not.toHaveBeenCalled();
  });

  it("answers 404 when the stored object is missing", async () => {
    getObjectBytes.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });

  it("answers 404 for a file that cannot be decoded", async () => {
    getObjectBytes.mockResolvedValue(Buffer.from("not an image"));
    expect((await get()).status).toBe(404);
  });

  it("serves a fresh JPEG with a private five minute cache header", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=300");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = new Uint8Array(await response.arrayBuffer());
    expect([body[0], body[1]]).toEqual([0xff, 0xd8]);
    expect(getObjectBytes).toHaveBeenCalledWith(KEY);
  });

  it("serves a repeat request from the cache, still checking the page each time", async () => {
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);
    expect(getObjectBytes).toHaveBeenCalledTimes(1);
    expect(imageKey).toHaveBeenCalledTimes(2);
  });

  it("answers 429 once one address uses up the shares.image limit", async () => {
    isR2Configured.mockReturnValue(false);
    const limit = RATE_LIMIT_POLICIES["shares.image"].ip.limit;
    for (let i = 0; i < limit; i++) {
      expect((await get("198.51.100.9")).status).toBe(404);
    }
    expect((await get("198.51.100.9")).status).toBe(429);
    expect((await get("198.51.100.10")).status).toBe(404);
  });
});
