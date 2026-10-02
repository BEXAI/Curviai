import { describe, expect, it, vi } from "vitest";
import { CurviApiError, CurviClient, CurviNetworkError, DEFAULT_BASE_URL, type FetchLike } from "./client.ts";

const KEY = "curvi_test_0123456789abcdef";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const PACK = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "queued",
  finished: false,
  productId: "22222222-2222-4222-8222-222222222222",
  productTitle: "Mug",
  channels: ["amazon.main"],
  creditsReserved: 2,
  creditsCharged: 0,
  createdAt: "2026-09-29T10:00:00.000Z",
  error: null,
  shots: [],
  links: {
    self: "/api/v1/packs/11111111-1111-4111-8111-111111111111",
    files: "/api/v1/packs/11111111-1111-4111-8111-111111111111/files",
  },
};
const PACK_BODY = { pack: PACK };

function client(fetchImpl: FetchLike, sleep = vi.fn(async () => {})) {
  return new CurviClient({ apiKey: KEY, fetch: fetchImpl, sleep, userAgent: "curvi-cli/test" });
}

describe("CurviClient", () => {
  it("needs a key and trims a trailing slash off the base URL", () => {
    expect(() => new CurviClient({ apiKey: "" })).toThrow();
    expect(new CurviClient({ apiKey: KEY }).baseUrl).toBe(DEFAULT_BASE_URL);
    expect(new CurviClient({ apiKey: KEY, baseUrl: "http://localhost:3000/api/v1/" }).baseUrl).toBe(
      "http://localhost:3000/api/v1",
    );
  });

  it("trims only the trailing slashes even after a long internal slash run", () => {
    const baseUrl = `https://example.com/${"/".repeat(200_000)}api/v1`;
    expect(new CurviClient({ apiKey: KEY, baseUrl: `${baseUrl}///` }).baseUrl).toBe(baseUrl);
    expect(new CurviClient({ apiKey: KEY, baseUrl }).baseUrl).toBe(baseUrl);
  });

  it("gets a pack and its files with the bearer key", async () => {
    const fetchImpl = vi.fn(async () => json(PACK_BODY));
    const c = client(fetchImpl);
    await expect(c.getPack(PACK.id)).resolves.toEqual(PACK_BODY);
    await c.listPackFiles(PACK.id);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_BASE_URL}/packs/${PACK.id}`);
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers["User-Agent"]).toBe("curvi-cli/test");
    expect(headers["Idempotency-Key"]).toBeUndefined();
    expect((fetchImpl.mock.calls[1] as unknown as [string])[0]).toBe(`${DEFAULT_BASE_URL}/packs/${PACK.id}/files`);
  });

  it("escapes the pack id into the path", async () => {
    const fetchImpl = vi.fn(async () => json(PACK_BODY));
    await client(fetchImpl).getPack("../admin?x=1");
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(`${DEFAULT_BASE_URL}/packs/..%2Fadmin%3Fx%3D1`);
  });

  it("sends a photo from disk as base64 JSON with the request fields", async () => {
    const fetchImpl = vi.fn(async () => json(PACK_BODY, 201));
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    await client(fetchImpl).createPack(
      [{ file: { name: "mug.jpg", bytes } }, { url: "https://example.com/back.jpg", angle: "back" }],
      { channels: ["amazon.main", "shopify.product"], bundle: "listing", look: "marketplace" },
      { idempotencyKey: "idem-1" },
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_BASE_URL}/packs`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("idem-1");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      channels: ["amazon.main", "shopify.product"],
      bundle: "listing",
      look: "marketplace",
      photos: [{ data: Buffer.from(bytes).toString("base64") }, { url: "https://example.com/back.jpg", angle: "back" }],
    });
  });

  it("makes an Idempotency-Key when none is given and sends no photos for an existing product", async () => {
    const fetchImpl = vi.fn(async () => json(PACK_BODY, 201));
    await client(fetchImpl).createPack([], { channels: ["amazon.main"], productId: PACK.productId });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(init.body as string)).toEqual({ channels: ["amazon.main"], productId: PACK.productId });
  });

  it("refuses more than eight photos before calling the API", () => {
    const fetchImpl = vi.fn(async () => json(PACK_BODY, 201));
    const photos = Array.from({ length: 9 }, (_, i) => ({ url: `https://example.com/${i}.jpg` }));
    expect(() => client(fetchImpl).createPack(photos, { channels: ["amazon.main"] })).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lists channels", async () => {
    const body = { channels: [], bundles: [{ key: "main", label: "Main image" }] };
    const fetchImpl = vi.fn(async () => json(body));
    await expect(client(fetchImpl).listChannels()).resolves.toEqual(body);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(`${DEFAULT_BASE_URL}/channels`);
  });

  it("checks a main image", async () => {
    const result = {
      pass: false,
      summary: "1 of 3 checks failed.",
      width: 1000,
      height: 1000,
      checks: [],
      rules: { minLongSide: 1000, fillMinPercent: 85, fillMaxPercent: 100 },
    };
    const fetchImpl = vi.fn(async () => json(result));
    await expect(client(fetchImpl).checkMainImage({ url: "https://example.com/main.jpg" })).resolves.toEqual(result);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_BASE_URL}/checks/main-image`);
    expect(JSON.parse(init.body as string)).toEqual({ url: "https://example.com/main.jpg" });
    // The check stores nothing, so it needs no Idempotency-Key.
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined();
  });

  it("turns an error body into a CurviApiError with its issues", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: "Invalid request.", reason: "invalid_request", issues: ["Unknown bundle."] }, 400),
    );
    const error = await client(fetchImpl)
      .createPack([{ url: "https://example.com/a.jpg" }], { channels: ["x"] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CurviApiError);
    expect(error).toMatchObject({
      status: 400,
      reason: "invalid_request",
      message: "Invalid request.",
      issues: ["Unknown bundle."],
    });
    // A 400 is never retried.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("names the status when the error body is not JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>bad gateway</html>", { status: 404 }));
    await expect(client(fetchImpl).getPack("x")).rejects.toMatchObject({
      status: 404,
      message: "The Curvi API answered 404.",
      reason: null,
    });
  });

  it("keeps the pack an Idempotency-Key already started on a 409", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: "Used.", reason: "idempotency_conflict", existingPackId: PACK.id }, 409),
    );
    await expect(client(fetchImpl).createPack([], { channels: ["amazon.main"] })).rejects.toMatchObject({
      status: 409,
      existingPackId: PACK.id,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 after Retry-After with the same Idempotency-Key", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ error: "Slow down." }, 429, { "Retry-After": "2" }))
      .mockResolvedValueOnce(json(PACK_BODY, 201));
    await client(fetchImpl, sleep).createPack(
      [{ file: { name: "a.png", bytes: new Uint8Array([1]) } }],
      { channels: ["amazon.main"] },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
    const keys = fetchImpl.mock.calls.map(
      (call) => ((call as [string, RequestInit])[1].headers as Record<string, string>)["Idempotency-Key"],
    );
    expect(keys[0]).toBe(keys[1]);
    // The retry sends the same body, so the server replays instead of refusing.
    expect((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body).toBe(
      (fetchImpl.mock.calls[1] as [string, RequestInit])[1].body,
    );
  });

  it("gives up after three attempts on a 503", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "Restarting." }, 503));
    await expect(client(fetchImpl).getPack("x")).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("waits for the body's retryAfterSeconds when there is no Retry-After header", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ error: "Wait.", reason: "rate_limited", retryAfterSeconds: 4 }, 429))
      .mockResolvedValueOnce(json(PACK_BODY));
    await client(fetchImpl, sleep).getPack("x");
    expect(sleep).toHaveBeenCalledWith(4000);
  });

  it("caps a long Retry-After", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ error: "Wait." }, 429, { "Retry-After": "3600" }))
      .mockResolvedValueOnce(json(PACK_BODY));
    await client(fetchImpl, sleep).getPack("x");
    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it("retries a network error, then reports it plainly", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const error = await client(fetchImpl).getPack("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CurviNetworkError);
    expect((error as Error).message).toBe(`Could not reach the Curvi API at ${DEFAULT_BASE_URL}.`);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
