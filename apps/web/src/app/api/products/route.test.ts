import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "@/lib/services/types";
import { MemoryRateLimitStore, RATE_LIMIT_POLICIES, setRateLimitStoreForTests } from "@/lib/rate-limit";
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
    const blocked = await POST(jsonRequest("https://curvi.ai/api/products", body));
    expect(blocked.status).toBe(429);
    expect(services.getCurrentWorkspace).not.toHaveBeenCalled();
  });
});
