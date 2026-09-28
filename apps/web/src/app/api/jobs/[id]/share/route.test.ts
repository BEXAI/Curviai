import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRateLimitStore, RATE_LIMIT_POLICIES, setRateLimitStoreForTests } from "@/lib/rate-limit";
import type { Services, WorkspaceRole } from "@/lib/services/types";
import { DemoShareState, DemoShareStore } from "@/lib/shares/demo-store";
import { createFakeServices, jsonRequest, TEST_JOB_ID, TEST_WORKSPACE_ID } from "@/lib/testing/fake-services";

let services: Services;
let store: DemoShareStore;

vi.mock("@/lib/services", () => ({
  getServices: () => services,
  isDbMode: () => false,
}));
vi.mock("@/lib/services/db", () => ({ getDb: () => null }));
vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => ({ id: "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a090" }),
  createSupabaseServerClient: async () => null,
}));
vi.mock("@/lib/shares", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/shares")>()),
  getShareStore: () => store,
}));

const { DELETE, GET, POST } = await import("./route");

const URL = `https://curvi.ai/api/jobs/${TEST_JOB_ID}/share`;
const params = (id = TEST_JOB_ID) => ({ params: Promise.resolve({ id }) });

function servicesWithPack(role: WorkspaceRole | null, done = true): Services {
  const fake = createFakeServices(role);
  vi.mocked(fake.listJobFiles).mockImplementation(async (_ws, jobId) =>
    jobId === TEST_JOB_ID
      ? {
          jobId,
          status: done ? "done" : "generating",
          files: done
            ? [{ id: "v_1", name: "MAIN.jpg", channel: "amazon", specId: "amazon.main", kind: "image", bytes: 1, url: "data:image/svg+xml,a", downloadUrl: null }]
            : [],
        }
      : null,
  );
  return fake;
}

beforeEach(() => {
  services = servicesWithPack("owner");
  store = new DemoShareStore(services, new DemoShareState());
  setRateLimitStoreForTests(new MemoryRateLimitStore());
});

afterEach(() => {
  setRateLimitStoreForTests(null);
});

describe("/api/jobs/[id]/share", () => {
  it("reports status, publishes, and takes the page down", async () => {
    const status = await GET(new Request(URL), params());
    expect(status.status).toBe(200);
    expect((await status.json()).share).toMatchObject({ eligible: true, published: false, canPublish: true });

    const published = await POST(jsonRequest(URL, { kind: "pack", gallery: true }), params());
    expect(published.status).toBe(200);
    const share = (await published.json()).share;
    expect(share).toMatchObject({ published: true, kind: "pack", inGallery: true });
    expect(share.path).toMatch(/^\/s\/[a-z2-9]{10}$/);
    expect(await store.getPublic(share.slug)).not.toBeNull();

    const down = await DELETE(new Request(URL, { method: "DELETE", headers: { "x-forwarded-for": "203.0.113.10" } }), params());
    expect(down.status).toBe(200);
    expect((await down.json()).share).toMatchObject({ published: false, path: null });
    expect(await store.getPublic(share.slug)).toBeNull();
  });

  it("answers 403 to a role that may not publish", async () => {
    services = servicesWithPack("editor");
    store = new DemoShareStore(services, new DemoShareState());
    const response = await POST(jsonRequest(URL, { kind: "before_after" }), params());
    expect(response.status).toBe(403);
    expect((await response.json()).reason).toBe("forbidden");
  });

  it("answers 409 while the pack has nothing to share", async () => {
    services = servicesWithPack("owner", false);
    store = new DemoShareStore(services, new DemoShareState());
    const response = await POST(jsonRequest(URL, { kind: "before_after" }), params());
    expect(response.status).toBe(409);
  });

  it("answers 401 signed out, 404 for a bad id and 400 for a bad body", async () => {
    services = servicesWithPack(null);
    expect((await GET(new Request(URL), params())).status).toBe(401);
    services = servicesWithPack("owner");
    expect((await GET(new Request(URL), params("not-a-uuid"))).status).toBe(404);
    expect((await GET(new Request(URL), params(TEST_WORKSPACE_ID))).status).toBe(404);
    expect((await POST(jsonRequest(URL, { kind: "everything" }), params())).status).toBe(400);
  });

  it("rate limits publishing by user", async () => {
    const { limit } = RATE_LIMIT_POLICIES["shares.write"].user;
    for (let i = 0; i < limit; i += 1) {
      const ok = await POST(
        jsonRequest(URL, { kind: "before_after" }, { "x-forwarded-for": `198.51.100.${i % 250}` }),
        params(),
      );
      expect(ok.status).toBe(200);
    }
    const blocked = await POST(jsonRequest(URL, { kind: "before_after" }, { "x-forwarded-for": "192.0.2.9" }), params());
    expect(blocked.status).toBe(429);
  });
});
