import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "@/lib/services/types";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { createFakeServices, TEST_WORKSPACE_ID } from "@/lib/testing/fake-services";

// PUT /api/workspace/seller-profile (docs/phases/PHASE_18.md P18-20): the
// first run answers, checked against the seed before the services see them.

let services: Services;

vi.mock("@/lib/services", () => ({
  getServices: () => services,
  isDbMode: () => true,
}));
vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => ({ id: "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a090" }),
  createSupabaseServerClient: async () => null,
}));

const { PUT } = await import("./route");

function put(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://curvi.ai/api/workspace/seller-profile", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
  services = createFakeServices("owner");
  setRateLimitStoreForTests(new MemoryRateLimitStore());
});

afterEach(() => {
  vi.unstubAllEnvs();
  setRateLimitStoreForTests(null);
});

describe("PUT /api/workspace/seller-profile", () => {
  it("saves a seeded answer, channels in seed order with no repeats", async () => {
    const response = await PUT(put({ category: "candles", channels: ["shopify", "amazon", "shopify"] }));
    expect(response.status).toBe(200);
    expect(services.saveSellerProfile).toHaveBeenCalledWith(TEST_WORKSPACE_ID, {
      category: "candles",
      channels: ["amazon", "shopify"],
    });
  });

  it("accepts an answer with only one part, or neither", async () => {
    expect((await PUT(put({ category: null, channels: ["etsy"] }))).status).toBe(200);
    expect((await PUT(put({ category: "pet" }))).status).toBe(200);
    expect((await PUT(put({ category: null, channels: [] }))).status).toBe(200);
  });

  it("refuses values outside the seed, before any service call", async () => {
    for (const body of [
      { category: "weapons", channels: [] },
      { category: "candles", channels: ["myspace"] },
      { category: "candles", channels: "amazon" },
      { category: 7, channels: [] },
      ["candles"],
      "not json",
    ]) {
      const response = await PUT(put(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(services.saveSellerProfile).not.toHaveBeenCalled();
    expect(services.ensureWorkspace).not.toHaveBeenCalled();
  });

  it("refuses a request from another site", async () => {
    const response = await PUT(put({ category: "candles", channels: [] }, { origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(services.saveSellerProfile).not.toHaveBeenCalled();
  });

  it("answers 401 signed out and 403 when the service refuses the seat", async () => {
    services = createFakeServices(null);
    expect((await PUT(put({ category: "candles", channels: [] }))).status).toBe(401);

    services = createFakeServices("client");
    vi.mocked(services.saveSellerProfile).mockResolvedValue({
      ok: false,
      notice: "Only owners, admins and editors can answer for the workspace.",
      reason: "forbidden",
    });
    const refused = await PUT(put({ category: "candles", channels: [] }));
    expect(refused.status).toBe(403);
  });
});
