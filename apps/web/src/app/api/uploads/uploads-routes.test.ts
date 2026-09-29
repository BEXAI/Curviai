import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "@/lib/services/types";
import { MemoryRateLimitStore, RATE_LIMIT_POLICIES, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { ProvisioningError } from "@/lib/services/errors";
import {
  OTHER_WORKSPACE_ID,
  TEST_PRODUCT_ID,
  TEST_WORKSPACE_ID,
  createFakeServices,
  jsonRequest,
} from "@/lib/testing/fake-services";

let services: Services;
const mode = vi.hoisted(() => ({ db: true }));

vi.mock("@/lib/services", () => ({
  getServices: () => services,
  isDbMode: () => mode.db,
}));
vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => ({ id: "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a090" }),
  createSupabaseServerClient: async () => null,
}));
vi.mock("@/lib/r2", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/r2")>()),
  presignSourceUpload: vi.fn(async (workspaceId: string) => ({
    url: "https://r2.example.com/put",
    key: `ws/${workspaceId}/src/new-upload`,
    bucket: "curvi-private",
    expiresInSeconds: 600,
  })),
}));

const { POST: sign } = await import("./sign/route");
const { POST: complete } = await import("./complete/route");

const signBody = { kind: "image", contentType: "image/jpeg", bytes: 1024 };
const completeBody = (overrides: Record<string, unknown> = {}) => ({
  productId: TEST_PRODUCT_ID,
  key: `ws/${TEST_WORKSPACE_ID}/src/photo.jpg`,
  kind: "image",
  bytes: 1024,
  sha256: "a".repeat(64),
  ...overrides,
});

beforeEach(() => {
  services = createFakeServices("owner");
  mode.db = true;
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  vi.stubEnv("R2_ACCOUNT_ID", "acct");
  vi.stubEnv("R2_ACCESS_KEY_ID", "key");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "secret");
});

afterEach(() => {
  setRateLimitStoreForTests(null);
  vi.unstubAllEnvs();
});

describe("POST /api/uploads/sign", () => {
  it("signs an upload for an owner", async () => {
    const response = await sign(jsonRequest("https://curvi.ai/api/uploads/sign", signBody));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { key: string };
    expect(body.key.startsWith(`ws/${TEST_WORKSPACE_ID}/src/`)).toBe(true);
  });

  it("answers 401 when signed out and 503 when the workspace could not be set up", async () => {
    services = createFakeServices(null);
    expect((await sign(jsonRequest("https://curvi.ai/api/uploads/sign", signBody))).status).toBe(401);
    services = createFakeServices("owner");
    vi.mocked(services.ensureWorkspace).mockRejectedValue(new ProvisioningError());
    const response = await sign(jsonRequest("https://curvi.ai/api/uploads/sign", signBody));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
  });

  it("refuses the client role (plan 4.3)", async () => {
    services = createFakeServices("client");
    const response = await sign(jsonRequest("https://curvi.ai/api/uploads/sign", signBody));
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Client seats can review assets but cannot upload files.");
  });

  it("answers 429 with Retry-After once the user limit is spent", async () => {
    const { limit } = RATE_LIMIT_POLICIES["uploads.sign"].user;
    for (let i = 0; i < limit; i += 1) {
      // Spread the calls over many IPs so only the per user limit applies.
      const ok = await sign(
        jsonRequest("https://curvi.ai/api/uploads/sign", signBody, { "x-forwarded-for": `198.51.100.${i % 250}` }),
      );
      expect(ok.status).toBe(200);
    }
    const blocked = await sign(jsonRequest("https://curvi.ai/api/uploads/sign", signBody, { "x-forwarded-for": "192.0.2.1" }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("answers 429 by IP before any auth work", async () => {
    const { limit } = RATE_LIMIT_POLICIES["uploads.sign"].ip;
    for (let i = 0; i < limit; i += 1) {
      await sign(jsonRequest("https://curvi.ai/api/uploads/sign", { kind: "image", contentType: "image/jpeg", bytes: -1 }));
    }
    vi.mocked(services.ensureWorkspace).mockClear();
    const blocked = await sign(jsonRequest("https://curvi.ai/api/uploads/sign", signBody));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(services.ensureWorkspace).not.toHaveBeenCalled();
  });

  it("answers { error: <copy>, reason } when R2 is not set up", async () => {
    vi.unstubAllEnvs();
    const response = await sign(jsonRequest("https://curvi.ai/api/uploads/sign", signBody));
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.reason).toBe("uploads_not_configured");
    expect(String(body.error)).toMatch(/Cloudflare R2/);
    expect(body.notice).toBeUndefined();
  });

  it("never signs an upload for the shared demo workspace, even with R2 set up", async () => {
    mode.db = false;
    const response = await sign(jsonRequest("https://curvi.ai/api/uploads/sign", signBody));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; reason: string };
    expect(body.reason).toBe("uploads_not_configured");
    expect(body.error).toMatch(/demo server/);
  });

  it("answers a validation refusal as { error: <copy>, reason }", async () => {
    const response = await sign(
      jsonRequest("https://curvi.ai/api/uploads/sign", { kind: "image", contentType: "image/jpeg", bytes: 26 * 1024 * 1024 }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "File is too large. The image limit is 25 MB.", reason: "invalid_upload" });
  });

  it("answers an empty content type with plain copy, not Invalid request", async () => {
    const response = await sign(jsonRequest("https://curvi.ai/api/uploads/sign", { ...signBody, contentType: "" }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; reason: string };
    expect(body.reason).toBe("invalid_upload");
    expect(body.error).toContain("This file type is not supported.");
  });

  it("refuses a content type over 100 characters", async () => {
    const response = await sign(
      jsonRequest("https://curvi.ai/api/uploads/sign", { ...signBody, contentType: `image/${"x".repeat(100)}` }),
    );
    expect(response.status).toBe(400);
  });

  it("refuses an oversized body with 413 and a cross site Origin with 403", async () => {
    const big = await sign(jsonRequest("https://curvi.ai/api/uploads/sign", { ...signBody, pad: "x".repeat(20_000) }));
    expect(big.status).toBe(413);
    const crossSite = await sign(jsonRequest("https://curvi.ai/api/uploads/sign", signBody, { origin: "https://evil.example" }));
    expect(crossSite.status).toBe(403);
    const sameSite = await sign(jsonRequest("https://curvi.ai/api/uploads/sign", signBody, { origin: "https://curvi.ai", host: "curvi.ai" }));
    expect(sameSite.status).not.toBe(403);
  });

  it("resolves the caller before reading the body", async () => {
    services = createFakeServices(null);
    const response = await sign(
      new Request("https://curvi.ai/api/uploads/sign", { method: "POST", body: "not json", headers: { "content-type": "application/json" } }),
    );
    expect(response.status).toBe(401);
  });
});

describe("POST /api/uploads/complete", () => {
  it("records an upload in the workspace's source prefix", async () => {
    const response = await complete(jsonRequest("https://curvi.ai/api/uploads/complete", completeBody()));
    expect(response.status).toBe(200);
    expect(services.registerSourceMedia).toHaveBeenCalledTimes(1);
  });

  it("rejects a non uuid product id with 400, never reaching the database", async () => {
    const response = await complete(jsonRequest("https://curvi.ai/api/uploads/complete", completeBody({ productId: "abc" })));
    expect(response.status).toBe(400);
    expect(services.registerSourceMedia).not.toHaveBeenCalled();
  });

  it.each([
    [`ws/${OTHER_WORKSPACE_ID}/src/photo.jpg`, "another workspace's source key"],
    [`ws/${TEST_WORKSPACE_ID}/jobs/j/files/amazon/main.jpg`, "an output key in this workspace"],
    [`ws/${TEST_WORKSPACE_ID}/src/../../${OTHER_WORKSPACE_ID}/src/x.jpg`, "a traversal key"],
  ])("rejects %s (%s) with 403", async (key) => {
    const response = await complete(jsonRequest("https://curvi.ai/api/uploads/complete", completeBody({ key })));
    expect(response.status).toBe(403);
    expect(services.registerSourceMedia).not.toHaveBeenCalled();
  });

  it("refuses the client role", async () => {
    services = createFakeServices("client");
    const response = await complete(jsonRequest("https://curvi.ai/api/uploads/complete", completeBody()));
    expect(response.status).toBe(403);
    expect(services.registerSourceMedia).not.toHaveBeenCalled();
  });

  it("answers typed refusals: 404 for an unknown product, 403 for a foreign key, each with its reason", async () => {
    vi.mocked(services.registerSourceMedia).mockResolvedValueOnce({
      ok: false,
      reason: "unknown_product",
      notice: "That product does not exist in this workspace.",
    });
    const unknown = await complete(jsonRequest("https://curvi.ai/api/uploads/complete", completeBody()));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: "That product does not exist in this workspace.",
      reason: "unknown_product",
    });

    vi.mocked(services.registerSourceMedia).mockResolvedValueOnce({
      ok: false,
      reason: "foreign_key",
      notice: "That upload does not belong to this workspace.",
    });
    const foreign = await complete(jsonRequest("https://curvi.ai/api/uploads/complete", completeBody()));
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as { reason: string }).reason).toBe("foreign_key");

    // The route's own prefix check names the same reason.
    const routeLevel = await complete(
      jsonRequest("https://curvi.ai/api/uploads/complete", completeBody({ key: `ws/${OTHER_WORKSPACE_ID}/src/x.jpg` })),
    );
    expect(routeLevel.status).toBe(403);
    expect(((await routeLevel.json()) as { reason: string }).reason).toBe("foreign_key");
  });

  it("answers 503 with Retry-After when the workspace could not be set up", async () => {
    vi.mocked(services.getCurrentWorkspace).mockRejectedValue(new ProvisioningError());
    const response = await complete(jsonRequest("https://curvi.ai/api/uploads/complete", completeBody()));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(services.registerSourceMedia).not.toHaveBeenCalled();
  });

  it("answers 429 once the user limit is spent", async () => {
    const { limit } = RATE_LIMIT_POLICIES["uploads.complete"].user;
    for (let i = 0; i < limit; i += 1) {
      await complete(
        jsonRequest("https://curvi.ai/api/uploads/complete", completeBody(), { "x-forwarded-for": `198.51.100.${i % 250}` }),
      );
    }
    const blocked = await complete(
      jsonRequest("https://curvi.ai/api/uploads/complete", completeBody(), { "x-forwarded-for": "192.0.2.1" }),
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });
});
