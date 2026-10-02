import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoFeedbackState, DemoFeedbackStore } from "@/lib/feedback/demo-store";
import { FEEDBACK_COPY } from "@/lib/feedback/copy";
import { MemoryRateLimitStore, RATE_LIMIT_POLICIES, setRateLimitStoreForTests } from "@/lib/rate-limit";
import type { JobView, Services, WorkspaceRole } from "@/lib/services/types";
import { createFakeServices, jsonRequest, TEST_JOB_ID, TEST_PRODUCT_ID } from "@/lib/testing/fake-services";

// P18-05: the pack page's feedback route. Status for the card, one answer
// per pack and person, only on a finished pack, every field validated,
// same origin and rate limited.

let services: Services;
let store: DemoFeedbackStore;

vi.mock("@/lib/services", () => ({
  getServices: () => services,
  isDbMode: () => false,
}));
vi.mock("@/lib/services/db", () => ({ getDb: () => null }));
vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => null,
  createSupabaseServerClient: async () => null,
}));
vi.mock("@/lib/feedback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/feedback")>()),
  getFeedbackStore: () => store,
}));

const { GET, POST } = await import("./route");

const URL = `https://curvi.ai/api/jobs/${TEST_JOB_ID}/feedback`;
const params = (id = TEST_JOB_ID) => ({ params: Promise.resolve({ id }) });

function servicesWithPack(role: WorkspaceRole | null, status: JobView["status"] = "done"): Services {
  const fake = createFakeServices(role);
  vi.mocked(fake.getJob).mockImplementation(async (_ws, jobId) =>
    jobId === TEST_JOB_ID
      ? ({
          id: jobId,
          productId: TEST_PRODUCT_ID,
          productTitle: "Candle",
          status,
          mode: "listing",
          channels: ["amazon.main"],
          creditsReserved: 0,
          creditsCharged: 8,
          createdAt: "2026-10-01T00:00:00Z",
          shots: [],
        } satisfies JobView)
      : null,
  );
  return fake;
}

beforeEach(() => {
  services = servicesWithPack("owner");
  store = new DemoFeedbackStore(services, new DemoFeedbackState());
  setRateLimitStoreForTests(new MemoryRateLimitStore());
});

afterEach(() => {
  setRateLimitStoreForTests(null);
});

describe("/api/jobs/[id]/feedback", () => {
  it("shows the card on a done pack, saves one answer, then hides it", async () => {
    const before = await GET(new Request(URL), params());
    expect(before.status).toBe(200);
    expect((await before.json()).feedback).toEqual({ jobId: TEST_JOB_ID, eligible: true, answered: false });

    const saved = await POST(jsonRequest(URL, { usable: "yes", comment: "Ready to list", wouldPay: "yes" }), params());
    expect(saved.status).toBe(201);
    expect((await saved.json()).feedback).toMatchObject({ answered: true });

    const again = await POST(jsonRequest(URL, { usable: "not_yet" }), params());
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ notice: FEEDBACK_COPY.already, feedback: { answered: true } });

    const after = await GET(new Request(URL), params());
    expect((await after.json()).feedback).toMatchObject({ answered: true });
  });

  it("answers 409 while the pack is running", async () => {
    services = servicesWithPack("owner", "generating");
    store = new DemoFeedbackStore(services, new DemoFeedbackState());
    expect((await (await GET(new Request(URL), params())).json()).feedback).toMatchObject({ eligible: false });
    const response = await POST(jsonRequest(URL, { usable: "yes" }), params());
    expect(response.status).toBe(409);
    expect((await response.json()).reason).toBe("not_ready");
  });

  it("lets a client seat answer too", async () => {
    services = servicesWithPack("client");
    store = new DemoFeedbackStore(services, new DemoFeedbackState());
    expect((await POST(jsonRequest(URL, { usable: "some" }), params())).status).toBe(201);
  });

  it("answers 400 for a bad answer, 404 for a bad id and 401 signed out", async () => {
    const bad = await POST(jsonRequest(URL, { usable: "maybe" }), params());
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe(FEEDBACK_COPY.pickUsable);
    const noWords = await POST(jsonRequest(URL, { usable: "yes", quoteConsent: true, displayName: "Ana" }), params());
    expect(noWords.status).toBe(400);
    expect((await POST(jsonRequest(URL, { usable: "yes" }), params("nope"))).status).toBe(404);
    expect((await GET(new Request(URL), params("00000000-0000-4000-8000-000000000999"))).status).toBe(404);

    services = servicesWithPack(null);
    expect((await GET(new Request(URL), params())).status).toBe(401);
    expect((await POST(jsonRequest(URL, { usable: "yes" }), params())).status).toBe(401);
  });

  it("refuses a cross site write and limits by IP", async () => {
    const crossSite = await POST(jsonRequest(URL, { usable: "yes" }, { origin: "https://evil.example" }), params());
    expect(crossSite.status).toBe(403);
    const { limit } = RATE_LIMIT_POLICIES["feedback.write"].ip;
    let last: Response | null = null;
    for (let i = 0; i <= limit; i += 1) {
      last = await POST(jsonRequest(URL, { usable: "yes" }, { "x-forwarded-for": "203.0.113.77" }), params());
    }
    expect(last?.status).toBe(429);
  });
});
