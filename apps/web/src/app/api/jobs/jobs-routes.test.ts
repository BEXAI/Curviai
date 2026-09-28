import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobView, Services } from "@/lib/services/types";
import { MemoryRateLimitStore, RATE_LIMIT_POLICIES, setRateLimitStoreForTests } from "@/lib/rate-limit";
import {
  OTHER_WORKSPACE_ID,
  TEST_JOB_ID,
  TEST_PRODUCT_ID,
  TEST_WORKSPACE_ID,
  createFakeServices,
  jsonRequest,
} from "@/lib/testing/fake-services";

let services: Services;

vi.mock("@/lib/services", () => ({
  getServices: () => services,
  isDbMode: () => false,
}));
vi.mock("@/lib/services/db", () => ({
  getDb: () => {
    throw new Error("the pack route must not reach the database in these tests");
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => ({ id: "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a090" }),
  createSupabaseServerClient: async () => null,
}));

const { POST: createJob } = await import("./route");
const { GET: getJob } = await import("./[id]/route");
const { GET: getFiles } = await import("./[id]/files/route");
const { GET: getPack } = await import("./[id]/pack/route");

const JOB: JobView = {
  id: TEST_JOB_ID,
  productId: TEST_PRODUCT_ID,
  productTitle: "Mug",
  status: "queued",
  mode: "listing",
  channels: ["amazon.main"],
  creditsReserved: 1,
  creditsCharged: 0,
  createdAt: new Date(0).toISOString(),
  shots: [],
};

const jobBody = (overrides: Record<string, unknown> = {}) => ({
  productId: TEST_PRODUCT_ID,
  channels: ["amazon.main"],
  mode: "listing",
  ...overrides,
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  createJob(jsonRequest("https://curvi.ai/api/jobs", body, { "idempotency-key": "k-1", ...headers }));

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  services = createFakeServices("owner");
  vi.mocked(services.createJob).mockResolvedValue({ outcome: "created", job: JOB });
  setRateLimitStoreForTests(new MemoryRateLimitStore());
});

afterEach(() => {
  setRateLimitStoreForTests(null);
});

describe("POST /api/jobs", () => {
  it("creates a job for a uuid product or a new product", async () => {
    expect((await post(jobBody())).status).toBe(201);
    expect((await post(jobBody({ productId: "new" }), { "idempotency-key": "k-2" })).status).toBe(201);
  });

  it.each(["abc", "", "NEW", "1234"])("rejects product id %j with 400 before the service (Update.md 4.7)", async (productId) => {
    const response = await post(jobBody({ productId }));
    expect(response.status).toBe(400);
    expect(services.createJob).not.toHaveBeenCalled();
  });

  it.each([
    [`ws/${TEST_WORKSPACE_ID}/jobs/j/files/amazon/main.jpg`, "an output key in this workspace"],
    [`ws/${OTHER_WORKSPACE_ID}/src/photo.jpg`, "another workspace's source key"],
    [`ws/${TEST_WORKSPACE_ID}/src/../../${OTHER_WORKSPACE_ID}/src/x.jpg`, "a traversal key"],
  ])("rejects upload %s (%s) with 403 (Update.md 4.6)", async (key) => {
    const response = await post(jobBody({ uploads: [{ key, sha256: "b".repeat(64), kind: "image" }] }));
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("That upload does not belong to this workspace.");
    expect(services.createJob).not.toHaveBeenCalled();
  });

  it("accepts uploads in the workspace source prefix", async () => {
    const key = `ws/${TEST_WORKSPACE_ID}/src/photo.jpg`;
    const response = await post(jobBody({ uploads: [{ key, sha256: "b".repeat(64), kind: "image" }] }));
    expect(response.status).toBe(201);
  });

  it("rejects an oversized Idempotency-Key", async () => {
    const response = await post(jobBody(), { "idempotency-key": "x".repeat(201) });
    expect(response.status).toBe(400);
  });

  it("answers 429 with Retry-After once the user limit is spent", async () => {
    const { limit } = RATE_LIMIT_POLICIES["jobs.create"].user;
    for (let i = 0; i < limit; i += 1) {
      const ok = await post(jobBody(), { "idempotency-key": `k-${i}`, "x-forwarded-for": `198.51.100.${i}` });
      expect(ok.status).toBe(201);
    }
    const blocked = await post(jobBody(), { "idempotency-key": "k-last", "x-forwarded-for": "192.0.2.1" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = (await blocked.json()) as { error: string };
    expect(body.error).toMatch(/^You are going a bit fast\. Try again in/);
  });

  it("answers 429 by IP", async () => {
    const { limit } = RATE_LIMIT_POLICIES["jobs.create"].ip;
    for (let i = 0; i < limit; i += 1) {
      await post(jobBody({ productId: "abc" }));
    }
    const blocked = await post(jobBody());
    expect(blocked.status).toBe(429);
  });
});

describe("GET /api/jobs/[id] and its files and pack routes (Update.md 4.7)", () => {
  it.each(["abc", "1", "0b7a4d1e5c3f4a2b9e8d7c6b5a4f3e2d", "' or 1=1 --"])("answers 404 for id %j without a query", async (id) => {
    for (const handler of [getJob, getFiles, getPack]) {
      const response = await handler(new Request(`https://curvi.ai/api/jobs/${encodeURIComponent(id)}`), params(id));
      expect(response.status).toBe(404);
    }
    expect(services.getJob).not.toHaveBeenCalled();
    expect(services.listJobFiles).not.toHaveBeenCalled();
    expect(services.ensureWorkspace).not.toHaveBeenCalled();
  });

  it("looks up a uuid id", async () => {
    vi.mocked(services.getJob).mockResolvedValue(JOB);
    const response = await getJob(new Request(`https://curvi.ai/api/jobs/${TEST_JOB_ID}`), params(TEST_JOB_ID));
    expect(response.status).toBe(200);
    expect(services.getJob).toHaveBeenCalledWith(TEST_WORKSPACE_ID, TEST_JOB_ID);
  });

  it("still answers 404 for an unknown uuid", async () => {
    const response = await getFiles(new Request(`https://curvi.ai/api/jobs/${TEST_JOB_ID}/files`), params(TEST_JOB_ID));
    expect(response.status).toBe(404);
    expect(services.listJobFiles).toHaveBeenCalledWith(TEST_WORKSPACE_ID, TEST_JOB_ID);
  });
});
