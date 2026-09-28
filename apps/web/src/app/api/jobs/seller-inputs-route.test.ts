import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobView, Services } from "@/lib/services/types";
import { MemoryRateLimitStore, setRateLimitStoreForTests } from "@/lib/rate-limit";
import {
  TEST_JOB_ID,
  TEST_PRODUCT_ID,
  TEST_WORKSPACE_ID,
  createFakeServices,
  jsonRequest,
} from "@/lib/testing/fake-services";

// POST /api/jobs checks the seller inputs against the limits the planner
// prints with, before the service is reached.

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

let keyCounter = 0;
const post = (overrides: Record<string, unknown>) => {
  keyCounter += 1;
  return createJob(
    jsonRequest(
      "https://curvi.ai/api/jobs",
      { productId: TEST_PRODUCT_ID, channels: ["amazon.main"], mode: "listing", ...overrides },
      { "idempotency-key": `seller-${keyCounter}` },
    ),
  );
};

const photo = (angle?: string) => ({
  key: `ws/${TEST_WORKSPACE_ID}/src/p-${angle ?? "none"}`,
  sha256: "a".repeat(64),
  kind: "image",
  ...(angle !== undefined ? { angle } : {}),
});

beforeEach(() => {
  services = createFakeServices("owner");
  vi.mocked(services.createJob).mockResolvedValue({ outcome: "created", job: JOB });
  setRateLimitStoreForTests(new MemoryRateLimitStore());
});

afterEach(() => {
  setRateLimitStoreForTests(null);
});

describe("POST /api/jobs seller inputs", () => {
  it("passes photo roles, SKU and trimmed lines to the service", async () => {
    const response = await post({
      uploads: [photo("front"), photo("in_the_box"), photo()],
      sku: " MUG-12_b.v2 ",
      boxContents: ["  Mug ", "Pour  over cone"],
      comparisonFacts: ["Holds 12 oz, most hold 8 oz"],
    });
    expect(response.status).toBe(201);
    const input = vi.mocked(services.createJob).mock.calls[0]?.[1];
    expect(input?.uploads?.map((u) => u.angle)).toEqual(["front", "in_the_box", undefined]);
    expect(input?.sku).toBe("MUG-12_b.v2");
    expect(input?.boxContents).toEqual(["Mug", "Pour over cone"]);
    expect(input?.comparisonFacts).toEqual(["Holds 12 oz, most hold 8 oz"]);
  });

  it("accepts an empty SKU and empty lists, which clear the saved values", async () => {
    expect((await post({ sku: "", boxContents: [], comparisonFacts: [] })).status).toBe(201);
  });

  it.each([
    ["an unknown photo role", { uploads: [photo("top")] }],
    ["a line too long to print whole", { boxContents: ["x".repeat(41)] }],
    ["an empty line", { comparisonFacts: ["   "] }],
    ["more than five lines", { boxContents: ["a", "b", "c", "d", "e", "f"] }],
    ["a SKU with a slash", { sku: "MUG/12" }],
    ["a SKU starting with a dot", { sku: ".hidden" }],
    ["a SKU over 40 characters", { sku: "A".repeat(41) }],
  ])("refuses %s with a 400 before the service", async (_label, overrides) => {
    const response = await post(overrides);
    expect(response.status).toBe(400);
    expect(services.createJob).not.toHaveBeenCalled();
  });
});
