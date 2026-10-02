import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "@/lib/services/types";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { TEST_JOB_ID, TEST_WORKSPACE_ID, createFakeServices } from "@/lib/testing/fake-services";

// PUT /api/assets/[assetId]/favorite and PUT /api/jobs/[id]/shots/[shotId]/pick
// (docs/phases/PHASE_16.md workstream 6): signed in, same origin, rate
// limited, a strict body, and the service's refusals mapped to statuses.

let services: Services;

vi.mock("@/lib/services", () => ({
  getServices: () => services,
  isDbMode: () => true,
}));
vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => ({ id: "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a090" }),
  createSupabaseServerClient: async () => null,
}));

const { PUT: favoritePut } = await import("./[assetId]/favorite/route");
const { PUT: pickPut } = await import("../jobs/[id]/shots/[shotId]/pick/route");

const ASSET_ID = "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b";

function put(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10", ...headers },
    body: JSON.stringify(body),
  });
}

const favoriteUrl = `https://curvi.ai/api/assets/${ASSET_ID}/favorite`;
const favoriteParams = { params: Promise.resolve({ assetId: ASSET_ID }) };
const pickUrl = `https://curvi.ai/api/jobs/${TEST_JOB_ID}/shots/s05_lifestyle.v2/pick`;
const pickParams = { params: Promise.resolve({ id: TEST_JOB_ID, shotId: "s05_lifestyle.v2" }) };

beforeEach(() => {
  services = createFakeServices("owner");
  setRateLimitStoreForTests(new MemoryRateLimitStore());
});

afterEach(() => {
  setRateLimitStoreForTests(null);
});

describe("PUT /api/assets/[assetId]/favorite", () => {
  it("saves a favorite in the caller's workspace", async () => {
    vi.mocked(services.setFavorite).mockResolvedValue({ outcome: "saved", favorite: true });
    const response = await favoritePut(put(favoriteUrl, { favorite: true }), favoriteParams);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ favorite: true });
    expect(services.setFavorite).toHaveBeenCalledWith(TEST_WORKSPACE_ID, ASSET_ID, true);
  });

  it("refuses a bad body, a bad id, a cross site request and signed out callers", async () => {
    expect((await favoritePut(put(favoriteUrl, { favorite: "yes" }), favoriteParams)).status).toBe(400);
    expect((await favoritePut(put(favoriteUrl, { favorite: true, extra: 1 }), favoriteParams)).status).toBe(400);
    expect(
      (await favoritePut(put(favoriteUrl, { favorite: true }), { params: Promise.resolve({ assetId: "nope" }) })).status,
    ).toBe(404);
    expect(
      (await favoritePut(put(favoriteUrl, { favorite: true }, { origin: "https://evil.example" }), favoriteParams)).status,
    ).toBe(403);
    services = createFakeServices(null);
    expect((await favoritePut(put(favoriteUrl, { favorite: true }), favoriteParams)).status).toBe(401);
    expect(services.setFavorite).not.toHaveBeenCalled();
  });

  it("never reads the body of a signed out caller and caps the body", async () => {
    services = createFakeServices(null);
    const unread = put(favoriteUrl, { favorite: true });
    expect((await favoritePut(unread, favoriteParams)).status).toBe(401);
    expect(unread.bodyUsed).toBe(false);
    services = createFakeServices("owner");
    const big = await favoritePut(put(favoriteUrl, { favorite: true, pad: "x".repeat(20_000) }), favoriteParams);
    expect(big.status).toBe(413);
    expect(services.setFavorite).not.toHaveBeenCalled();
  });

  it("maps refusals to statuses", async () => {
    vi.mocked(services.setFavorite).mockResolvedValue({ outcome: "rejected", reason: "not_found", message: "No." });
    expect((await favoritePut(put(favoriteUrl, { favorite: true }), favoriteParams)).status).toBe(404);
    vi.mocked(services.setFavorite).mockResolvedValue({ outcome: "rejected", reason: "role_forbidden", message: "No." });
    expect((await favoritePut(put(favoriteUrl, { favorite: true }), favoriteParams)).status).toBe(403);
  });
});

describe("PUT /api/jobs/[id]/shots/[shotId]/pick", () => {
  it("picks a version and returns the job", async () => {
    vi.mocked(services.pickShotVersion).mockResolvedValue({ outcome: "saved", job: { id: TEST_JOB_ID } as never });
    const response = await pickPut(put(pickUrl, { picked: true }), pickParams);
    expect(response.status).toBe(200);
    expect(services.pickShotVersion).toHaveBeenCalledWith(TEST_WORKSPACE_ID, TEST_JOB_ID, "s05_lifestyle.v2", true);
  });

  it("refuses a signed out caller before the body and an oversized body with 413", async () => {
    services = createFakeServices(null);
    const unread = put(pickUrl, { picked: true });
    expect((await pickPut(unread, pickParams)).status).toBe(401);
    expect(unread.bodyUsed).toBe(false);
    services = createFakeServices("owner");
    expect((await pickPut(put(pickUrl, { picked: true, pad: "x".repeat(20_000) }), pickParams)).status).toBe(413);
    expect(services.pickShotVersion).not.toHaveBeenCalled();
  });

  it("answers 409 for a full channel and 400 for a bad body", async () => {
    vi.mocked(services.pickShotVersion).mockResolvedValue({ outcome: "rejected", reason: "channel_full", message: "Full." });
    expect((await pickPut(put(pickUrl, { picked: true }), pickParams)).status).toBe(409);
    expect((await pickPut(put(pickUrl, {}), pickParams)).status).toBe(400);
  });
});
