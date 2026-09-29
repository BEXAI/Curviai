import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "@/lib/services/types";
import { MemoryRateLimitStore, RATE_LIMIT_POLICIES, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { demoPreflight } from "@/lib/preflight/demo";
import {
  OTHER_WORKSPACE_ID,
  TEST_WORKSPACE_ID,
  createFakeServices,
  jsonRequest,
} from "@/lib/testing/fake-services";

// POST /api/uploads/preflight (docs/phases/PHASE_14.md workstream 4): auth,
// workspace scope, same origin and rate limits like the other upload routes.

let services: Services;

vi.mock("@/lib/services", () => ({
  getServices: () => services,
  isDbMode: () => true,
}));
vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => ({ id: "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a090" }),
  createSupabaseServerClient: async () => null,
}));

const { POST } = await import("./preflight/route");

const URL = "https://curvi.ai/api/uploads/preflight";
const key = `ws/${TEST_WORKSPACE_ID}/src/cafe.jpg`;

beforeEach(() => {
  services = createFakeServices("owner");
  vi.mocked(services.preflightUpload).mockImplementation(async (_ws, input) => ({
    ok: true,
    preflight: demoPreflight(input.key, input.note),
  }));
  setRateLimitStoreForTests(new MemoryRateLimitStore());
});

afterEach(() => {
  setRateLimitStoreForTests(null);
});

describe("POST /api/uploads/preflight", () => {
  it("checks an upload in the caller's workspace with the note", async () => {
    const response = await POST(jsonRequest(URL, { key, note: "  just the watch " }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { preflight: { key: string; status: string } };
    expect(body.preflight).toMatchObject({ key, status: "ready" });
    expect(services.preflightUpload).toHaveBeenCalledWith(TEST_WORKSPACE_ID, { key, note: "just the watch" });
  });

  it("answers 401 signed out and 403 for a client seat, before any check", async () => {
    services = createFakeServices(null);
    expect((await POST(jsonRequest(URL, { key }))).status).toBe(401);
    services = createFakeServices("client");
    const response = await POST(jsonRequest(URL, { key }));
    expect(response.status).toBe(403);
    expect(services.preflightUpload).not.toHaveBeenCalled();
  });

  it("refuses a key from another workspace", async () => {
    const response = await POST(jsonRequest(URL, { key: `ws/${OTHER_WORKSPACE_ID}/src/cafe.jpg` }));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { reason: string }).reason).toBe("foreign_key");
    expect(services.preflightUpload).not.toHaveBeenCalled();
  });

  it("refuses a post from another site", async () => {
    const response = await POST(jsonRequest(URL, { key }, { origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(services.preflightUpload).not.toHaveBeenCalled();
  });

  it("validates the body", async () => {
    expect((await POST(jsonRequest(URL, {}))).status).toBe(400);
    expect((await POST(jsonRequest(URL, { key, note: "x".repeat(2001) }))).status).toBe(400);
  });

  it("maps refusals to their status", async () => {
    vi.mocked(services.preflightUpload).mockResolvedValueOnce({ ok: false, reason: "invalid_upload", message: "Not a photo." });
    expect((await POST(jsonRequest(URL, { key }))).status).toBe(422);
    vi.mocked(services.preflightUpload).mockResolvedValueOnce({ ok: false, reason: "unavailable", message: "Later." });
    expect((await POST(jsonRequest(URL, { key }))).status).toBe(503);
  });

  it("is rate limited per user like the upload routes", async () => {
    const limit = RATE_LIMIT_POLICIES["uploads.preflight"].user.limit;
    expect(limit).toBe(RATE_LIMIT_POLICIES["uploads.complete"].user.limit);
    for (let i = 0; i < limit; i++) {
      await POST(jsonRequest(URL, { key }));
    }
    const limited = await POST(jsonRequest(URL, { key }));
    expect(limited.status).toBe(429);
  });
});
