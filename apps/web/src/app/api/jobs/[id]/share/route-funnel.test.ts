import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import type { Services } from "@/lib/services/types";
import { DemoShareState, DemoShareStore } from "@/lib/shares/demo-store";
import { createFakeServices, jsonRequest, TEST_JOB_ID, TEST_WORKSPACE_ID } from "@/lib/testing/fake-services";

// P18-02: publishing a share page is a funnel.share_published step in the
// publisher's workspace; a refused publish writes nothing.

let services: Services;
let store: DemoShareStore;
const recordFunnel = vi.hoisted(() => vi.fn(async () => ({ recorded: true, firstRecorded: false })));

vi.mock("@/lib/funnel", () => ({ recordFunnel }));
vi.mock("@/lib/services", () => ({ getServices: () => services, isDbMode: () => false }));
vi.mock("@/lib/services/db", () => ({ getDb: () => null }));
vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => ({ id: "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a090" }),
  createSupabaseServerClient: async () => null,
}));
vi.mock("@/lib/shares", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/shares")>()),
  getShareStore: () => store,
}));

const { POST } = await import("./route");

const URL = `https://curvi.ai/api/jobs/${TEST_JOB_ID}/share`;
const params = () => ({ params: Promise.resolve({ id: TEST_JOB_ID }) });

function servicesFor(role: "owner" | "editor"): Services {
  const fake = createFakeServices(role);
  vi.mocked(fake.listJobFiles).mockImplementation(async (_ws, jobId) =>
    jobId === TEST_JOB_ID
      ? {
          jobId,
          status: "done",
          files: [{ id: "v_1", name: "MAIN.jpg", channel: "amazon", specId: "amazon.main", kind: "image", bytes: 1, url: "data:image/svg+xml,a", downloadUrl: null }],
        }
      : null,
  );
  return fake;
}

beforeEach(() => {
  recordFunnel.mockClear();
  setRateLimitStoreForTests(new MemoryRateLimitStore());
});

afterEach(() => {
  setRateLimitStoreForTests(null);
});

describe("POST /api/jobs/[id]/share funnel step", () => {
  it("records share_published with the kind and gallery choice", async () => {
    services = servicesFor("owner");
    store = new DemoShareStore(services, new DemoShareState());
    expect((await POST(jsonRequest(URL, { kind: "pack", gallery: true }), params())).status).toBe(200);
    expect(recordFunnel).toHaveBeenCalledWith({
      workspaceId: TEST_WORKSPACE_ID,
      name: "share_published",
      props: { kind: "pack", gallery: true },
    });
  });

  it("records nothing when publishing is refused", async () => {
    services = servicesFor("editor");
    store = new DemoShareStore(services, new DemoShareState());
    expect((await POST(jsonRequest(URL, { kind: "pack", gallery: false }), params())).status).toBe(403);
    expect(recordFunnel).not.toHaveBeenCalled();
  });
});
