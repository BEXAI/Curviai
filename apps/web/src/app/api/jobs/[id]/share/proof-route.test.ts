import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { SCENE_CAPTION } from "@/lib/proof-copy";
import type { JobView, Services } from "@/lib/services/types";
import { DemoShareState, DemoShareStore } from "@/lib/shares/demo-store";
import { createFakeServices, jsonRequest, TEST_JOB_ID } from "@/lib/testing/fake-services";

// P18-16 through the share route on the demo store: proof is off unless
// the owner asks, a republish that leaves it out keeps the choice, and the
// demo page lists the checks with the scene caption and nothing measured.

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

const { POST } = await import("./route");

const URL = `https://curvi.ai/api/jobs/${TEST_JOB_ID}/share`;
const params = () => ({ params: Promise.resolve({ id: TEST_JOB_ID }) });

function packServices(): Services {
  const fake = createFakeServices("owner");
  const image = (id: string, specId: string) => ({
    id,
    name: `${id}.jpg`,
    channel: specId.split(".")[0],
    specId,
    kind: "image" as const,
    bytes: null,
    url: "data:image/svg+xml,a",
    downloadUrl: null,
  });
  vi.mocked(fake.listJobFiles).mockResolvedValue({
    jobId: TEST_JOB_ID,
    status: "done",
    files: [image("demo_s01_amazon_main", "amazon.main"), image("demo_s02_lifestyle", "meta.feed_1x1")],
  });
  const job: JobView = {
    id: TEST_JOB_ID,
    productId: "p1",
    productTitle: "Amber candle",
    status: "done",
    mode: "listing",
    channels: ["amazon", "meta"],
    creditsReserved: 8,
    creditsCharged: 8,
    createdAt: "2026-10-01T12:00:00.000Z",
    shots: [
      { shotId: "s01_amazon_main", shotType: "amazon_main", providerStage: "pixel pipeline", status: "done", channels: ["amazon.main"], credits: 1, compliance: null },
      { shotId: "s02_lifestyle", shotType: "lifestyle", providerStage: "image model", status: "done", channels: ["meta.feed_1x1"], credits: 3, compliance: null },
    ],
  };
  vi.mocked(fake.getJob).mockResolvedValue(job);
  return fake;
}

beforeEach(() => {
  services = packServices();
  store = new DemoShareStore(services, new DemoShareState());
  setRateLimitStoreForTests(new MemoryRateLimitStore());
});

afterEach(() => {
  setRateLimitStoreForTests(null);
});

describe("POST /api/jobs/[id]/share with proof", () => {
  it("publishes without proof by default and with it when asked", async () => {
    const plain = (await (await POST(jsonRequest(URL, { kind: "pack" }), params())).json()).share;
    expect(plain.showProof).toBe(false);
    const quiet = await store.getPublic(plain.slug);
    expect(quiet?.proof).toBe(false);
    expect(quiet?.images.every((image) => image.proof === undefined)).toBe(true);

    const shown = (await (await POST(jsonRequest(URL, { kind: "pack", proof: true }), params())).json()).share;
    expect(shown.showProof).toBe(true);
    const page = (await store.getPublic(shown.slug))!;
    expect(page.proof).toBe(true);
    const scene = page.images.find((image) => image.specId === "meta.feed_1x1");
    expect(scene?.proof?.caption).toBe(SCENE_CAPTION);
    expect(scene?.proof?.rows.length).toBeGreaterThan(0);
    // A demo page measures nothing: every row says so and carries no verdict.
    expect(scene?.proof?.rows.every((row) => row.pass === null && row.measured === "Not measured")).toBe(true);
    expect(scene?.proof?.productUnchanged).toBeNull();
    const main = page.images.find((image) => image.specId === "amazon.main");
    expect(main?.proof?.caption).toBeNull();
  });

  it("keeps the choice on a republish that leaves proof out", async () => {
    await POST(jsonRequest(URL, { kind: "pack", proof: true }), params());
    const again = (await (await POST(jsonRequest(URL, { kind: "before_after" }), params())).json()).share;
    expect(again.showProof).toBe(true);
  });

  it("answers 400 for a proof that is not true or false", async () => {
    expect((await POST(jsonRequest(URL, { kind: "pack", proof: "yes" }), params())).status).toBe(400);
  });
});
