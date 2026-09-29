import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobView, Services } from "@/lib/services/types";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { TEST_JOB_ID, TEST_PRODUCT_ID, TEST_WORKSPACE_ID, createFakeServices, jsonRequest } from "@/lib/testing/fake-services";

// The chooser's box rides the pack request (docs/phases/PHASE_14.md 3.2):
// validated here, then saved by createJob on source_media.target_box.

let services: Services;

vi.mock("@/lib/services", () => ({
  getServices: () => services,
  isDbMode: () => false,
}));
vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => ({ id: "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a090" }),
  createSupabaseServerClient: async () => null,
}));

const { POST } = await import("./route");

const JOB: JobView = {
  id: TEST_JOB_ID,
  productId: TEST_PRODUCT_ID,
  productTitle: "Watch",
  status: "queued",
  mode: "listing",
  channels: ["amazon.main"],
  creditsReserved: 1,
  creditsCharged: 0,
  createdAt: new Date(0).toISOString(),
  shots: [],
};

const upload = (targetBox: unknown) => ({
  key: `ws/${TEST_WORKSPACE_ID}/src/cafe.jpg`,
  sha256: "a".repeat(64),
  kind: "image",
  targetBox,
});

let counter = 0;
const post = (uploads: unknown[]) =>
  POST(
    jsonRequest(
      "https://curvi.ai/api/jobs",
      { productId: "new", channels: ["amazon.main"], mode: "listing", uploads },
      { "idempotency-key": `tb-${++counter}` },
    ),
  );

beforeEach(() => {
  services = createFakeServices("owner");
  vi.mocked(services.createJob).mockResolvedValue({ outcome: "created", job: JOB });
  setRateLimitStoreForTests(new MemoryRateLimitStore());
});

afterEach(() => {
  setRateLimitStoreForTests(null);
});

describe("POST /api/jobs with a chosen product", () => {
  it("passes the tapped box to createJob", async () => {
    const box = { x: 0.5, y: 0.5, width: 0.4, height: 0.3 };
    expect((await post([upload(box)])).status).toBe(201);
    expect(vi.mocked(services.createJob).mock.calls[0][1].uploads?.[0].targetBox).toEqual(box);
  });

  it.each([
    { x: 0.8, y: 0.1, width: 0.5, height: 0.2 },
    { x: -0.1, y: 0, width: 0.5, height: 0.5 },
    { x: 0, y: 0, width: 0, height: 0.5 },
    { x: 0, y: 0, width: 0.5, height: 0.5, extra: 1 },
    "left",
  ])("refuses a box outside the photo or out of shape: %j", async (box) => {
    expect((await post([upload(box)])).status).toBe(400);
    expect(services.createJob).not.toHaveBeenCalled();
  });
});
