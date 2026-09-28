import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "@/lib/services/types";
import { MemoryRateLimitStore, RATE_LIMIT_POLICIES, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { ProvisioningError } from "@/lib/services/errors";
import { createFakeServices, jsonRequest } from "@/lib/testing/fake-services";

let services: Services;

vi.mock("@/lib/services", () => ({
  getServices: () => services,
  isDbMode: () => true,
}));
vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => ({ id: "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a090" }),
  createSupabaseServerClient: async () => null,
}));

const { POST } = await import("./route");

const body = { title: "Copper kettle", mode: "listing" };

beforeEach(() => {
  services = createFakeServices("owner");
  setRateLimitStoreForTests(new MemoryRateLimitStore());
});

afterEach(() => {
  setRateLimitStoreForTests(null);
});

describe("POST /api/products", () => {
  it("creates a product", async () => {
    const response = await POST(jsonRequest("https://curvi.ai/api/products", body));
    expect(response.status).toBe(201);
  });

  it("answers 429 with Retry-After once the user limit is spent", async () => {
    const { limit } = RATE_LIMIT_POLICIES["products.create"].user;
    for (let i = 0; i < limit; i += 1) {
      const ok = await POST(
        jsonRequest("https://curvi.ai/api/products", body, { "x-forwarded-for": `198.51.100.${i % 250}` }),
      );
      expect(ok.status).toBe(201);
    }
    const blocked = await POST(jsonRequest("https://curvi.ai/api/products", body, { "x-forwarded-for": "192.0.2.1" }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(services.createProduct).toHaveBeenCalledTimes(limit);
  });

  it("answers 429 by IP before auth", async () => {
    const { limit } = RATE_LIMIT_POLICIES["products.create"].ip;
    for (let i = 0; i < limit; i += 1) {
      await POST(jsonRequest("https://curvi.ai/api/products", { title: "", mode: "listing" }));
    }
    vi.mocked(services.ensureWorkspace).mockClear();
    const blocked = await POST(jsonRequest("https://curvi.ai/api/products", body));
    expect(blocked.status).toBe(429);
    expect(services.ensureWorkspace).not.toHaveBeenCalled();
  });

  it("resolves the workspace like the other routes: 401 signed out, 503 when setup failed", async () => {
    services = createFakeServices(null);
    const signedOut = await POST(jsonRequest("https://curvi.ai/api/products", body));
    expect(signedOut.status).toBe(401);
    expect(await signedOut.json()).toEqual({ error: "Sign in to add a product." });

    services = createFakeServices("owner");
    vi.mocked(services.ensureWorkspace).mockRejectedValue(new ProvisioningError());
    const failed = await POST(jsonRequest("https://curvi.ai/api/products", body));
    expect(failed.status).toBe(503);
    expect(failed.headers.get("Retry-After")).toBe("60");
    expect(services.createProduct).not.toHaveBeenCalled();
  });

  it("creates the workspace of a new signed in user through ensureWorkspace", async () => {
    await POST(jsonRequest("https://curvi.ai/api/products", body));
    expect(services.ensureWorkspace).toHaveBeenCalled();
    expect(services.getCurrentWorkspace).not.toHaveBeenCalled();
  });

  it("refuses a cross site Origin with 403 before any work", async () => {
    const response = await POST(jsonRequest("https://curvi.ai/api/products", body, { origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(services.ensureWorkspace).not.toHaveBeenCalled();
  });
});
