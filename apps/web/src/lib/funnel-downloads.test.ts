import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import type { Services } from "@/lib/services/types";
import { createFakeServices, TEST_JOB_ID, TEST_WORKSPACE_ID } from "@/lib/testing/fake-services";

// P18-02: every download route writes funnel.download and the workspace's
// first_download (the pack zip, one file, and the API's signed links); a
// refused download writes nothing.

let services: Services;
const recordFunnel = vi.hoisted(() => vi.fn(async () => ({ recorded: true, firstRecorded: true })));
const listPackFiles = vi.hoisted(() => vi.fn());
const zipJob = vi.hoisted(() => ({ value: null as null | { id: string; status: string; creditsCharged: number } }));

const fakeDb = vi.hoisted(() => ({
  query: {
    generationJobs: { findFirst: vi.fn(async () => zipJob.value) },
    assets: { findMany: vi.fn(async () => [{ id: "a_1" }]) },
    assetVariants: {
      findMany: vi.fn(async () => [
        {
          assetId: "a_1",
          picked: true,
          r2Key: "ws/0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d/out/main.jpg",
          channelSpecId: "amazon.main",
          filename: "MAIN.jpg",
        },
      ]),
    },
    packFiles: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("@/lib/funnel", () => ({ recordFunnel }));
vi.mock("@/lib/services", () => ({ getServices: () => services, isDbMode: () => true }));
vi.mock("@/lib/services/db", () => ({
  getDb: () => fakeDb,
  servesFiles: (job: { status: string }) => job.status === "done",
}));
vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => ({ id: "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a090" }),
  createSupabaseServerClient: async () => null,
}));
vi.mock("@/lib/r2", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/r2")>()),
  objectExists: async () => true,
  r2Client: () => ({ send: async () => ({}) }),
  privateBucket: () => "bucket",
}));
vi.mock("@/lib/http/zip-stream", () => ({ zipStream: () => new ReadableStream() }));
vi.mock("@/lib/api-v1/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-v1/http")>()),
  authorize: async () => ({ caller: { principal: { workspaceId: TEST_WORKSPACE_ID } } }),
}));
vi.mock("@/lib/api-v1/actions", () => ({ listPackFiles }));

const fileRoute = await import("@/app/api/jobs/[id]/files/[fileId]/route");
const packRoute = await import("@/app/api/jobs/[id]/pack/route");
const v1Route = await import("@/app/api/v1/packs/[id]/files/route");

const R2_ENV = { R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "key-id", R2_SECRET_ACCESS_KEY: "key-secret" };

beforeEach(() => {
  recordFunnel.mockClear();
  listPackFiles.mockReset();
  services = createFakeServices("owner");
  zipJob.value = null;
  setRateLimitStoreForTests(new MemoryRateLimitStore());
  for (const [name, value] of Object.entries(R2_ENV)) vi.stubEnv(name, value);
});

afterEach(() => {
  setRateLimitStoreForTests(null);
  vi.unstubAllEnvs();
});

const firstDownload = (kind: string) => ({ workspaceId: TEST_WORKSPACE_ID, name: "download", first: true, props: { kind } });

describe("download funnel steps", () => {
  it("one file", async () => {
    vi.mocked(services.getJobFileDownload).mockResolvedValueOnce({ url: "https://r2.example/signed", filename: "MAIN.jpg" });
    const ok = await fileRoute.GET(new Request("https://curvi.ai/x"), { params: Promise.resolve({ id: TEST_JOB_ID, fileId: "v_1" }) });
    expect(ok.status).toBe(302);
    expect(recordFunnel).toHaveBeenCalledWith(firstDownload("file"));

    recordFunnel.mockClear();
    vi.mocked(services.getJobFileDownload).mockResolvedValueOnce(null);
    const missing = await fileRoute.GET(new Request("https://curvi.ai/x"), { params: Promise.resolve({ id: TEST_JOB_ID, fileId: "v_9" }) });
    expect(missing.status).toBe(404);
    expect(recordFunnel).not.toHaveBeenCalled();
  });

  it("the pack zip", async () => {
    zipJob.value = { id: TEST_JOB_ID, status: "done", creditsCharged: 8 };
    const ok = await packRoute.GET(new Request("https://curvi.ai/x"), { params: Promise.resolve({ id: TEST_JOB_ID }) });
    expect(ok.status).toBe(200);
    expect(recordFunnel).toHaveBeenCalledWith(firstDownload("zip"), fakeDb);

    recordFunnel.mockClear();
    zipJob.value = { id: TEST_JOB_ID, status: "generating", creditsCharged: 0 };
    const early = await packRoute.GET(new Request("https://curvi.ai/x"), { params: Promise.resolve({ id: TEST_JOB_ID }) });
    expect(early.status).toBe(409);
    expect(recordFunnel).not.toHaveBeenCalled();
  });

  it("the API's signed links", async () => {
    listPackFiles.mockResolvedValueOnce({ status: 200, body: { packId: TEST_JOB_ID, files: [{ id: "v_1", url: "https://r2.example/s" }] } });
    const request = new Request("https://curvi.ai/api/v1/packs/x/files", { headers: { authorization: "Bearer cv_live_x" } });
    expect((await v1Route.GET(request, { params: Promise.resolve({ id: TEST_JOB_ID }) })).status).toBe(200);
    expect(recordFunnel).toHaveBeenCalledWith(firstDownload("api"));

    recordFunnel.mockClear();
    listPackFiles.mockResolvedValueOnce({ status: 200, body: { packId: TEST_JOB_ID, status: "generating", files: [{ id: "v_1", url: null }] } });
    await v1Route.GET(request, { params: Promise.resolve({ id: TEST_JOB_ID }) });
    listPackFiles.mockResolvedValueOnce({ status: 404, body: { error: "not found" } });
    await v1Route.GET(request, { params: Promise.resolve({ id: TEST_JOB_ID }) });
    expect(recordFunnel).not.toHaveBeenCalled();
  });
});
