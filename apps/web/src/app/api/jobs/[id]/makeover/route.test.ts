import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobView, Services } from "@/lib/services/types";
import { MemoryRateLimitStore, RATE_LIMIT_POLICIES, setRateLimitStoreForTests } from "@/lib/rate-limit";
import { createFakeServices, TEST_JOB_ID, TEST_PRODUCT_ID, TEST_WORKSPACE_ID } from "@/lib/testing/fake-services";
import { MAKEOVER_MAX_INPUT_BYTES, readImageUrl } from "@/lib/makeover-image";

let services: Services;

vi.mock("@/lib/services", () => ({
  getServices: () => services,
  isDbMode: () => true,
}));
vi.mock("@/lib/supabase/server", () => ({
  getSessionUser: async () => ({ id: "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a090" }),
  createSupabaseServerClient: async () => null,
}));

const { GET } = await import("./route");

function svgUrl(fill: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${fill}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function doneJob(overrides: Partial<JobView> = {}): JobView {
  return {
    id: TEST_JOB_ID,
    productId: TEST_PRODUCT_ID,
    productTitle: "Copper Kettle",
    status: "done",
    mode: "listing",
    channels: ["amazon.main"],
    creditsReserved: 4,
    creditsCharged: 4,
    createdAt: new Date(0).toISOString(),
    sourceImageUrl: svgUrl("#aa3333"),
    shots: [
      {
        shotId: "s01_amazon_main",
        shotType: "amazon_main",
        providerStage: "pixel pipeline",
        status: "done",
        channels: ["amazon.main"],
        credits: 1,
        compliance: null,
        imageUrl: svgUrl("#3333aa"),
      },
      {
        shotId: "s02_lifestyle",
        shotType: "lifestyle",
        providerStage: "image model",
        status: "needs_review",
        channels: [],
        credits: 0,
        compliance: null,
        imageUrl: svgUrl("#33aa33"),
      },
    ],
    ...overrides,
  };
}

function request(shot: string | null, id = TEST_JOB_ID, ip = "203.0.113.10"): [Request, { params: Promise<{ id: string }> }] {
  const url = new URL(`https://curvi.ai/api/jobs/${id}/makeover`);
  if (shot !== null) {
    url.searchParams.set("shot", shot);
  }
  return [new Request(url, { headers: { "x-forwarded-for": ip } }), { params: Promise.resolve({ id }) }];
}

beforeEach(() => {
  services = createFakeServices("owner");
  vi.mocked(services.getJob).mockResolvedValue(doneJob());
  setRateLimitStoreForTests(new MemoryRateLimitStore());
});

afterEach(() => {
  setRateLimitStoreForTests(null);
});

describe("GET /api/jobs/:id/makeover", () => {
  it("renders a named side by side JPEG for a finished shot of the caller's pack", async () => {
    const response = await GET(...request("s01_amazon_main"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-disposition")).toContain("copper-kettle-before-after-amazon-main.jpg");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const bytes = Buffer.from(await response.arrayBuffer());
    // JPEG magic bytes; the layout itself is covered in @curvi/pipeline.
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(Number(response.headers.get("content-length"))).toBe(bytes.length);
    expect(services.getJob).toHaveBeenCalledWith(TEST_WORKSPACE_ID, TEST_JOB_ID);
  });

  it("refuses a shot that did not pass, an unknown shot and a missing shot parameter", async () => {
    expect((await GET(...request("s02_lifestyle"))).status).toBe(404);
    expect((await GET(...request("s99_nope"))).status).toBe(404);
    expect((await GET(...request(null))).status).toBe(400);
  });

  it("answers 404 for a job id that is not a uuid or not in the workspace", async () => {
    expect((await GET(...request("s01_amazon_main", "not-a-job"))).status).toBe(404);
    expect(services.getJob).not.toHaveBeenCalled();
    vi.mocked(services.getJob).mockResolvedValue(null);
    expect((await GET(...request("s01_amazon_main"))).status).toBe(404);
  });

  it("waits for the pack to finish and needs the original photo", async () => {
    vi.mocked(services.getJob).mockResolvedValue(doneJob({ status: "packaging" }));
    expect((await GET(...request("s01_amazon_main"))).status).toBe(409);
    vi.mocked(services.getJob).mockResolvedValue(doneJob({ sourceImageUrl: null }));
    expect((await GET(...request("s01_amazon_main"))).status).toBe(404);
  });

  it("answers 401 when signed out", async () => {
    services = createFakeServices(null);
    expect((await GET(...request("s01_amazon_main"))).status).toBe(401);
  });

  it("answers a retryable 503 in plain words when a picture cannot be read", async () => {
    vi.mocked(services.getJob).mockResolvedValue(doneJob({ sourceImageUrl: "http://insecure.example/a.jpg" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await GET(...request("s01_amazon_main"));
    warn.mockRestore();
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toContain("Try again");
  });

  it("is rate limited per user", async () => {
    const { limit } = RATE_LIMIT_POLICIES["jobs.makeover"].user;
    vi.mocked(services.getJob).mockResolvedValue(doneJob({ status: "packaging" }));
    for (let i = 0; i < limit; i += 1) {
      await GET(...request("s01_amazon_main", TEST_JOB_ID, `198.51.100.${i % 250}`));
    }
    const blocked = await GET(...request("s01_amazon_main", TEST_JOB_ID, "192.0.2.1"));
    expect(blocked.status).toBe(429);
    expect(services.getJob).toHaveBeenCalledTimes(limit);
  });
});

describe("readImageUrl", () => {
  it("decodes inline data urls, plain and base64", async () => {
    expect((await readImageUrl("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E")).toString()).toBe("<svg/>");
    expect((await readImageUrl(`data:image/png;base64,${Buffer.from("abc").toString("base64")}`)).toString()).toBe("abc");
  });

  it("reads https urls and refuses every other scheme", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    expect([...(await readImageUrl("https://acct.r2.cloudflarestorage.com/a.jpg", fetchImpl))]).toEqual([1, 2, 3]);
    for (const url of ["http://example.com/a.jpg", "file:///etc/passwd", "data:text/html,hi", "ftp://x/y"]) {
      await expect(readImageUrl(url, fetchImpl)).rejects.toThrow();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a failed fetch and a picture over the size cap", async () => {
    await expect(readImageUrl("https://x/a.jpg", async () => new Response("", { status: 403 }))).rejects.toThrow();
    const huge = async () =>
      new Response("x", { status: 200, headers: { "content-length": String(MAKEOVER_MAX_INPUT_BYTES + 1) } });
    await expect(readImageUrl("https://x/a.jpg", huge)).rejects.toThrow("too large");
  });
});
