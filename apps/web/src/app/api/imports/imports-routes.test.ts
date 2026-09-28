import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "@/lib/services/types";
import { MemoryRateLimitStore, RATE_LIMIT_POLICIES, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { ProvisioningError } from "@/lib/services/errors";
import { TEST_WORKSPACE_ID, createFakeServices, jsonRequest } from "@/lib/testing/fake-services";
import type { SafeFetchOptions, SafeFetchResult } from "@/lib/url-import/safe-fetch";

let services: Services;
let dbMode = true;

vi.mock("@/lib/services", () => ({
  getServices: () => services,
  isDbMode: () => dbMode,
}));
vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => ({ id: "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a090" }),
  createSupabaseServerClient: async () => null,
}));
vi.mock("@/lib/r2", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/r2")>()),
  putSourceObject: vi.fn(async (workspaceId: string) => `ws/${workspaceId}/src/imported-photo`),
}));
// The network edge: every outside fetch the routes make goes through here.
const safeFetchMock = vi.fn<(url: string | URL, options: SafeFetchOptions) => Promise<SafeFetchResult>>();
vi.mock("@/lib/url-import/safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-import/safe-fetch")>()),
  safeFetch: (url: string | URL, options: SafeFetchOptions) => safeFetchMock(url, options),
}));

const { POST: importProductRoute } = await import("./product/route");
const { POST: importPhotoRoute } = await import("./photo/route");
const { putSourceObject } = await import("@/lib/r2");

const PRODUCT_URL = "https://store.example.com/products/linen-apron";
const SHOP_JSON = JSON.stringify({
  product: {
    title: "Linen Apron",
    body_html: "<p>Stone washed.</p>",
    images: [{ src: "https://cdn.shopify.com/apron.png", position: 1 }],
  },
});

function png(): Buffer {
  const buf = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(1200, 16);
  buf.writeUInt32BE(1500, 20);
  return buf;
}

beforeEach(() => {
  services = createFakeServices("owner");
  dbMode = true;
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  safeFetchMock.mockReset();
  safeFetchMock.mockImplementation(async (url) => {
    const href = url.toString();
    if (href === `${PRODUCT_URL}.json`) {
      return { status: 200, contentType: "application/json", body: Buffer.from(SHOP_JSON), url: new URL(href) };
    }
    if (href === "https://cdn.shopify.com/apron.png") {
      return { status: 200, contentType: "image/png", body: png(), url: new URL(href) };
    }
    return { status: 404, contentType: "text/html", body: Buffer.alloc(0), url: new URL(href) };
  });
  vi.mocked(putSourceObject).mockClear();
  vi.stubEnv("R2_ACCOUNT_ID", "acct");
  vi.stubEnv("R2_ACCESS_KEY_ID", "key");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "secret");
});

afterEach(() => {
  setRateLimitStoreForTests(null);
  vi.unstubAllEnvs();
});

describe("POST /api/imports/product", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    importProductRoute(jsonRequest("https://curvi.ai/api/imports/product", body, headers));

  it("returns the imported product for a member", async () => {
    const response = await post({ url: PRODUCT_URL });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { product: { title: string; images: Array<{ url: string }> } };
    expect(body.product.title).toBe("Linen Apron");
    expect(body.product.images[0]?.url).toBe("https://cdn.shopify.com/apron.png");
  });

  it("answers 401 signed out and 503 when the workspace could not be set up, before fetching", async () => {
    services = createFakeServices(null);
    expect((await post({ url: PRODUCT_URL })).status).toBe(401);
    services = createFakeServices("owner");
    vi.mocked(services.ensureWorkspace).mockRejectedValue(new ProvisioningError());
    expect((await post({ url: PRODUCT_URL })).status).toBe(503);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("refuses client seats", async () => {
    services = createFakeServices("client");
    const response = await post({ url: PRODUCT_URL });
    expect(response.status).toBe(403);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("refuses private, http and non product links with 400 and never fetches them", async () => {
    for (const url of [
      "http://store.example.com/products/a",
      "https://169.254.169.254/products/a",
      "https://localhost/products/a",
      "https://store.example.com/about",
      "",
    ]) {
      const response = await post({ url });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; reason: string };
      expect(body.error).toBeTruthy();
    }
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("limits imports per workspace, across addresses", async () => {
    const { limit } = RATE_LIMIT_POLICIES["imports.product"].user;
    for (let i = 0; i < limit; i += 1) {
      const ok = await post({ url: PRODUCT_URL }, { "x-forwarded-for": `198.51.100.${i % 250}` });
      expect(ok.status).toBe(200);
    }
    const blocked = await post({ url: PRODUCT_URL }, { "x-forwarded-for": "192.0.2.1" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    // A second user in the same workspace shares the count.
    const other = await post({ url: PRODUCT_URL }, { "x-forwarded-for": "192.0.2.2" });
    expect(other.status).toBe(429);
  });

  it("limits by IP before any auth work", async () => {
    const { limit } = RATE_LIMIT_POLICIES["imports.product"].ip;
    for (let i = 0; i < limit; i += 1) {
      await post({ url: 5 });
    }
    vi.mocked(services.ensureWorkspace).mockClear();
    const blocked = await post({ url: PRODUCT_URL });
    expect(blocked.status).toBe(429);
    expect(services.ensureWorkspace).not.toHaveBeenCalled();
  });
});

describe("POST /api/imports/photo", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    importPhotoRoute(jsonRequest("https://curvi.ai/api/imports/photo", body, headers));

  it("stores the photo under this workspace's source prefix and answers like an upload", async () => {
    const response = await post({ url: "https://cdn.shopify.com/apron.png" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      key: `ws/${TEST_WORKSPACE_ID}/src/imported-photo`,
      kind: "image",
      contentType: "image/png",
      width: 1200,
      height: 1500,
    });
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(putSourceObject).toHaveBeenCalledWith(TEST_WORKSPACE_ID, expect.any(Buffer), "image/png");
  });

  it("answers 503 with the notice as the error when R2 is not set up", async () => {
    vi.unstubAllEnvs();
    const response = await post({ url: "https://cdn.shopify.com/apron.png" });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error?: string; reason?: string; notice?: string };
    expect(body.reason).toBe("uploads_not_configured");
    expect(body.error).toMatch(/Cloudflare R2/);
    expect(body.notice).toBeUndefined();
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("stores nothing for the shared demo workspace, even with R2 set up", async () => {
    dbMode = false;
    const response = await post({ url: "https://cdn.shopify.com/apron.png" });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error?: string; reason?: string };
    expect(body.reason).toBe("uploads_not_configured");
    expect(body.error).toMatch(/demo server/);
    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(putSourceObject).not.toHaveBeenCalled();
  });

  it("refuses a cross site Origin and an oversized body before any work", async () => {
    const crossSite = await post({ url: "https://cdn.shopify.com/apron.png" }, { origin: "https://evil.example" });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toMatchObject({ reason: "cross_site" });
    expect(services.ensureWorkspace).not.toHaveBeenCalled();

    const tooLarge = await post({ url: `https://cdn.shopify.com/${"a".repeat(20_000)}.png` });
    expect(tooLarge.status).toBe(413);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("does not read the body of a signed out caller", async () => {
    services = createFakeServices(null);
    const response = await importPhotoRoute(
      new Request("https://curvi.ai/api/imports/photo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json at all",
      }),
    );
    expect(response.status).toBe(401);
  });

  it("refuses client seats and signed out callers before fetching", async () => {
    services = createFakeServices("client");
    expect((await post({ url: "https://cdn.shopify.com/apron.png" })).status).toBe(403);
    services = createFakeServices(null);
    expect((await post({ url: "https://cdn.shopify.com/apron.png" })).status).toBe(401);
    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(putSourceObject).not.toHaveBeenCalled();
  });

  it("stores nothing when the link is not an image", async () => {
    safeFetchMock.mockResolvedValue({
      status: 200,
      contentType: "image/png",
      body: Buffer.from("<svg onload=alert(1)>"),
      url: new URL("https://cdn.example.com/x.png"),
    });
    const response = await post({ url: "https://cdn.example.com/x.png" });
    expect(response.status).toBe(422);
    expect(putSourceObject).not.toHaveBeenCalled();
  });

  it("limits photo imports per workspace", async () => {
    const { limit } = RATE_LIMIT_POLICIES["imports.photo"].user;
    for (let i = 0; i < limit; i += 1) {
      await post({ url: "https://cdn.shopify.com/apron.png" }, { "x-forwarded-for": `198.51.100.${i % 250}` });
    }
    const blocked = await post({ url: "https://cdn.shopify.com/apron.png" }, { "x-forwarded-for": "192.0.2.9" });
    expect(blocked.status).toBe(429);
  });
});
