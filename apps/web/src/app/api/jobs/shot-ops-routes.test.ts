import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobView, Services } from "@/lib/services/types";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import {
  OTHER_WORKSPACE_ID,
  TEST_JOB_ID,
  TEST_PRODUCT_ID,
  TEST_WORKSPACE_ID,
  createFakeServices,
  jsonRequest,
} from "@/lib/testing/fake-services";

// Route level behavior for the pack operations: cancel, retry a shot and
// add a photo. Authorization (signed in, a member, not a client seat) and
// input checks happen before the service; the service's answers map to
// fixed statuses.

let services: Services;

vi.mock("@/lib/services", () => ({
  getServices: () => services,
  isDbMode: () => false,
}));
vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => ({ id: "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a090" }),
  createSupabaseServerClient: async () => null,
}));

const { POST: cancel } = await import("./[id]/cancel/route");
const { POST: retry } = await import("./[id]/shots/[shotId]/retry/route");
const { POST: photo } = await import("./[id]/shots/[shotId]/photo/route");

const JOB: JobView = {
  id: TEST_JOB_ID,
  productId: TEST_PRODUCT_ID,
  productTitle: "Mug",
  status: "canceled",
  mode: "listing",
  channels: ["amazon.main"],
  creditsReserved: 4,
  creditsCharged: 0,
  createdAt: new Date(0).toISOString(),
  shots: [],
};

const SHOT_ID = "skipped_03_alt_angle_white:back";
const jobParams = (id: string) => ({ params: Promise.resolve({ id }) });
const shotParams = (id: string, shotId: string) => ({ params: Promise.resolve({ id, shotId }) });
const url = "https://curvi.ai/api/jobs";

beforeEach(() => {
  services = createFakeServices("owner");
  setRateLimitStoreForTests(new MemoryRateLimitStore());
});

afterEach(() => {
  setRateLimitStoreForTests(null);
});

describe("POST /api/jobs/[id]/cancel", () => {
  it("cancels and says how many credits went back", async () => {
    vi.mocked(services.cancelJob).mockResolvedValue({
      outcome: "canceled",
      job: JOB,
      refundedCredits: 4,
      notice: "This pack was canceled. 4 credits went back to your balance.",
    });
    const response = await cancel(jsonRequest(url, {}), jobParams(TEST_JOB_ID));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "canceled", refundedCredits: 4, job: { status: "canceled" } });
    expect(services.cancelJob).toHaveBeenCalledWith(TEST_WORKSPACE_ID, TEST_JOB_ID);
  });

  it("answers 409 for a pack that already finished", async () => {
    vi.mocked(services.cancelJob).mockResolvedValue({ outcome: "finished", job: { ...JOB, status: "done" }, notice: "done" });
    expect((await cancel(jsonRequest(url, {}), jobParams(TEST_JOB_ID))).status).toBe(409);
  });

  it("answers 404 for a pack outside the caller's workspace and for an id that is not a uuid", async () => {
    vi.mocked(services.cancelJob).mockResolvedValue({ outcome: "rejected", reason: "not_found", message: "Not found." });
    expect((await cancel(jsonRequest(url, {}), jobParams(TEST_JOB_ID))).status).toBe(404);
    expect((await cancel(jsonRequest(url, {}), jobParams("not-a-job"))).status).toBe(404);
    expect(services.cancelJob).toHaveBeenCalledTimes(1);
  });

  it("answers 401 signed out and 403 to client seats, before the service", async () => {
    services = createFakeServices(null);
    expect((await cancel(jsonRequest(url, {}), jobParams(TEST_JOB_ID))).status).toBe(401);
    services = createFakeServices("client");
    const response = await cancel(jsonRequest(url, {}), jobParams(TEST_JOB_ID));
    expect(response.status).toBe(403);
    expect(services.cancelJob).not.toHaveBeenCalled();
  });
});

describe("POST /api/jobs/[id]/shots/[shotId]/retry", () => {
  it("starts the shot and answers 202 with the credits held", async () => {
    vi.mocked(services.retryShot).mockResolvedValue({ outcome: "started", job: { ...JOB, status: "generating" }, creditsHeld: 0.5 });
    const response = await retry(jsonRequest(url, {}), shotParams(TEST_JOB_ID, "s04_alt_angle_white"));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ creditsHeld: 0.5 });
    expect(services.retryShot).toHaveBeenCalledWith(TEST_WORKSPACE_ID, TEST_JOB_ID, "s04_alt_angle_white");
  });

  it.each([
    ["insufficient_credits", 402],
    ["role_forbidden", 403],
    ["not_found", 404],
    ["not_ready", 409],
    ["not_retryable", 409],
    ["channel_full", 409],
    ["unavailable", 503],
  ] as const)("maps %s to %i", async (reason, status) => {
    vi.mocked(services.retryShot).mockResolvedValue({ outcome: "rejected", reason, message: "No." });
    const response = await retry(jsonRequest(url, {}), shotParams(TEST_JOB_ID, "s04_alt_angle_white"));
    expect(response.status).toBe(status);
    if (status === 503) {
      expect(response.headers.get("Retry-After")).toBeTruthy();
    }
  });

  it.each(["../../x", "a b", "x".repeat(121), ""])("answers 404 for shot id %j before the service", async (shotId) => {
    expect((await retry(jsonRequest(url, {}), shotParams(TEST_JOB_ID, shotId))).status).toBe(404);
    expect(services.retryShot).not.toHaveBeenCalled();
  });
});

describe("POST /api/jobs/[id]/shots/[shotId]/photo", () => {
  const body = (key = `ws/${TEST_WORKSPACE_ID}/src/back.jpg`) => ({ key, sha256: "a".repeat(64) });

  it("adds the photo and answers 202", async () => {
    vi.mocked(services.addShotPhoto).mockResolvedValue({ outcome: "started", job: { ...JOB, status: "generating" }, creditsHeld: 0.5 });
    const response = await photo(jsonRequest(url, body()), shotParams(TEST_JOB_ID, SHOT_ID));
    expect(response.status).toBe(202);
    expect(services.addShotPhoto).toHaveBeenCalledWith(TEST_WORKSPACE_ID, TEST_JOB_ID, SHOT_ID, body());
  });

  it("refuses another workspace's upload with 403 before the service", async () => {
    const response = await photo(jsonRequest(url, body(`ws/${OTHER_WORKSPACE_ID}/src/back.jpg`)), shotParams(TEST_JOB_ID, SHOT_ID));
    expect(response.status).toBe(403);
    expect(services.addShotPhoto).not.toHaveBeenCalled();
  });

  it("answers 400 for a body without a valid sha256", async () => {
    const response = await photo(jsonRequest(url, { key: body().key, sha256: "nope" }), shotParams(TEST_JOB_ID, SHOT_ID));
    expect(response.status).toBe(400);
    expect(services.addShotPhoto).not.toHaveBeenCalled();
  });

  it("maps a photo saved to another product to 409", async () => {
    vi.mocked(services.addShotPhoto).mockResolvedValue({ outcome: "rejected", reason: "conflict", message: "Saved elsewhere." });
    expect((await photo(jsonRequest(url, body()), shotParams(TEST_JOB_ID, SHOT_ID))).status).toBe(409);
  });

  it("maps a photo that fails the server side upload check to 422 with its reason", async () => {
    vi.mocked(services.addShotPhoto).mockResolvedValue({
      outcome: "rejected",
      reason: "invalid_upload",
      message: "That file is not a photo we can use.",
    });
    const response = await photo(jsonRequest(url, body()), shotParams(TEST_JOB_ID, SHOT_ID));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "That file is not a photo we can use.", reason: "invalid_upload" });
  });

  it("refuses a cross site Origin and an oversized body before the service", async () => {
    const crossSite = await photo(jsonRequest(url, body(), { origin: "https://evil.example" }), shotParams(TEST_JOB_ID, SHOT_ID));
    expect(crossSite.status).toBe(403);
    const big = await photo(jsonRequest(url, { ...body(), pad: "x".repeat(20_000) }), shotParams(TEST_JOB_ID, SHOT_ID));
    expect(big.status).toBe(413);
    expect(services.addShotPhoto).not.toHaveBeenCalled();
  });
});

describe("cross site requests on the other pack operations", () => {
  it("refuses cancel and retry from another site before the service", async () => {
    const cancelResponse = await cancel(jsonRequest(url, {}, { origin: "https://evil.example" }), jobParams(TEST_JOB_ID));
    expect(cancelResponse.status).toBe(403);
    const retryResponse = await retry(jsonRequest(url, {}, { origin: "https://evil.example" }), shotParams(TEST_JOB_ID, "s04_alt_angle_white"));
    expect(retryResponse.status).toBe(403);
    expect(services.cancelJob).not.toHaveBeenCalled();
    expect(services.retryShot).not.toHaveBeenCalled();
  });
});
