import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobView, Services } from "@/lib/services/types";
import { JOB_BODY_MAX_BYTES } from "@/lib/http/json-body";
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

describe("POST /api/jobs output options (PHASE_15)", () => {
  it("passes valid options to the service with the defaults filled", async () => {
    const response = await post({
      outputOptions: {
        lookBase: "keep_photo",
        background: "keep",
        color: { kind: "custom", hex: "#1f2a44" },
        fit: "pad",
        extras: { scenes: true },
      },
    });
    expect(response.status).toBe(201);
    const input = vi.mocked(services.createJob).mock.calls[0]?.[1];
    expect(input?.outputOptions).toEqual({
      v: 1,
      lookBase: "keep_photo",
      background: "keep",
      color: { kind: "custom", hex: "#1f2a44" },
      fit: "pad",
      extras: { scenes: true },
      sceneCount: 3,
      scenePreset: "auto",
      logo: true,
      productSize: "standard",
      enlarge: true,
      graphicsColor: false,
      bundle: "everything",
    });
  });

  it("accepts every P1 field and a background per photo (PHASE_15 P1)", async () => {
    const response = await post({
      uploads: [
        {
          key: `ws/${TEST_WORKSPACE_ID}/src/a.jpg`,
          sha256: "a".repeat(64),
          kind: "image",
          background: "keep",
        },
      ],
      outputOptions: {
        background: "keep",
        color: { kind: "edge_match" },
        fit: "crop",
        sceneCount: 1,
        scenePreset: "holiday",
        logo: false,
        productSize: "larger",
        enlarge: false,
        graphicsColor: true,
      },
    });
    expect(response.status).toBe(201);
    const input = vi.mocked(services.createJob).mock.calls[0]?.[1];
    expect(input?.uploads?.[0]?.background).toBe("keep");
    expect(input?.outputOptions).toMatchObject({ fit: "crop", color: { kind: "edge_match" }, sceneCount: 1 });
  });

  it.each(["main", "listing", "aplus", "everything"])("accepts the %s bundle (PHASE_16)", async (bundle) => {
    expect((await post({ outputOptions: { bundle } })).status).toBe(201);
    const input = vi.mocked(services.createJob).mock.calls[0]?.[1];
    expect(input?.outputOptions?.bundle).toBe(bundle);
  });

  it("refuses a background per photo the schema does not know", async () => {
    const response = await post({
      uploads: [{ key: `ws/${TEST_WORKSPACE_ID}/src/a.jpg`, sha256: "a".repeat(64), kind: "image", background: "blur" }],
    });
    expect(response.status).toBe(400);
    expect(services.createJob).not.toHaveBeenCalled();
  });

  it("accepts a request with no options, a swatch and a brand color", async () => {
    expect((await post({})).status).toBe(201);
    expect((await post({ outputOptions: { color: { kind: "swatch", key: "sand" } } })).status).toBe(201);
    expect((await post({ outputOptions: { color: { kind: "brand", index: 5 } } })).status).toBe(201);
  });

  it.each([
    ["a short hex", { color: { kind: "custom", hex: "#FFF" } }],
    ["a named color", { color: { kind: "custom", hex: "red" } }],
    ["a hex with bad digits", { color: { kind: "custom", hex: "#GGGGGG" } }],
    ["a brand index past the kit limit", { color: { kind: "brand", index: 6 } }],
    ["an unknown swatch", { color: { kind: "swatch", key: "neon" } }],
    ["an unknown key", { background: "keep", glow: true }],
    ["an unknown extra", { extras: { stickers: true } }],
    ["an unknown fit", { fit: "stretch" }],
    ["an edge match color with a hex", { color: { kind: "edge_match", hex: "#FFFFFF" } }],
    ["a scene count past the seeded bounds", { sceneCount: 5 }],
    ["no scenes as a count", { sceneCount: 0 }],
    ["an unknown scene style", { scenePreset: "neon" }],
    ["an unknown product size", { productSize: "huge" }],
    ["an unknown version", { v: 2 }],
    ["an unknown bundle", { bundle: "most" }],
    ["a bundle list", { bundle: ["main"] }],
    ["a null bundle", { bundle: null }],
    ["a bundle key in another case", { bundle: "Main" }],
  ])("refuses %s with a 400 before the service", async (_label, outputOptions) => {
    const response = await post({ outputOptions });
    expect(response.status).toBe(400);
    expect(services.createJob).not.toHaveBeenCalled();
  });

  it("keeps a maximal body under the body cap", async () => {
    const body = {
      productId: TEST_PRODUCT_ID,
      channels: Array.from({ length: 24 }, (_, i) => `channel.${String(i).padStart(56, "x")}`),
      mode: "listing",
      uploads: Array.from({ length: 8 }, (_, i) => ({
        key: `ws/${TEST_WORKSPACE_ID}/src/${"k".repeat(470)}${i}`,
        sha256: "a".repeat(64),
        kind: "image",
        angle: "in_the_box",
        targetBox: { x: 0.123456789, y: 0.123456789, width: 0.5, height: 0.5 },
        background: "remove",
      })),
      newProductTitle: "T".repeat(120),
      userDescription: "D".repeat(2000),
      sku: "S".repeat(40),
      boxContents: Array.from({ length: 5 }, () => "B".repeat(40)),
      comparisonFacts: Array.from({ length: 5 }, () => "C".repeat(40)),
      outputOptions: {
        v: 1,
        lookBase: "marketplace",
        background: "remove",
        color: { kind: "custom", hex: "#ABCDEF" },
        fit: "pad",
        extras: { scenes: false, backdrops: false, transparentPng: false, graphics: false, cards: false },
        sceneCount: 4,
        scenePreset: "kitchen_lifestyle",
        logo: false,
        productSize: "smaller",
        enlarge: false,
        graphicsColor: true,
        bundle: "everything",
      },
    };
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThan(JOB_BODY_MAX_BYTES);
  });
});
