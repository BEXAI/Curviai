import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  assets: [] as Array<{ id: string; qc: Record<string, unknown> }>,
  variants: [] as Array<Record<string, unknown>>,
  opened: [] as string[], missing: false,
}));
const workspaceId = "00000000-0000-4000-8000-000000000001";
const jobId = "00000000-0000-4000-8000-000000000002";
vi.mock("@/lib/env", () => ({ isR2Configured: () => true }));
vi.mock("@/lib/services", () => ({ isDbMode: () => true }));
vi.mock("@/lib/http/services", () => ({ resolveSignedIn: async () => ({ workspace: { id: workspaceId } }) }));
vi.mock("@/lib/rate-limit", () => ({ limitByIp: async () => null, limitByUser: async () => null, userRateLimitSubject: async () => "user" }));
vi.mock("@/lib/funnel", () => ({ recordFunnel: async () => {} }));
vi.mock("@/lib/services/db", () => ({ servesFiles: () => true, getDb: () => ({ query: {
  generationJobs: { findFirst: async () => ({ id: jobId, status: "done" }) },
  assets: { findMany: async () => fixture.assets }, assetVariants: { findMany: async () => fixture.variants },
  packFiles: { findMany: async () => [] },
} }) }));
vi.mock("@/lib/r2", () => ({
  isWorkspaceKey: (id: string, key: string) => key.startsWith(`ws/${id}/`),
  getObjectBytes: async () => null, getObjectBytesBounded: async () => null, objectExists: async () => !fixture.missing, privateBucket: () => "test",
  r2Client: () => ({ send: async (command: { input: { Key: string } }) => { fixture.opened.push(command.input.Key); return { Body: Readable.from(["pixels"]) }; } }),
}));
vi.mock("@/lib/http/zip-stream", () => ({ zipStream: (entries: Array<{ name: string; source: string }>, open: (key: string) => Promise<Readable | null>) => new ReadableStream({
  async start(controller) {
    const output = [];
    for (const entry of entries) {
      const stream = await open(entry.source); const chunks = [];
      for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
      output.push({ name: entry.name, content: Buffer.concat(chunks).toString() });
    }
    controller.enqueue(new TextEncoder().encode(JSON.stringify(output))); controller.close();
  },
}) }));
const { GET } = await import("./[id]/pack/route");
beforeEach(() => {
  fixture.opened = []; fixture.missing = false;
  const key = `ws/${workspaceId}/jobs/${jobId}/files/meta/ads/feed_4x5/v1.jpg`;
  fixture.assets = [{ id: "a", qc: { shotId: "ad1", shot: { type: "ad_variant", headline: "=formula()", cta: "Buy" }, fileReports: { [key]: {
    file: "ads/feed_4x5/v1.jpg", channel: "meta", specId: "meta.feed_4x5", checks: [], pass: true,
  } } } }];
  fixture.variants = [{ assetId: "a", r2Key: key, filename: "ads/feed_4x5/v1.jpg", channelSpecId: "meta.feed_4x5", picked: true },
    { assetId: "a", r2Key: `${key}-unpicked`, filename: "ignored.jpg", channelSpecId: "meta.feed_4x5", picked: false }];
});
describe("all files ZIP contents", () => {
  it("streams picked pixels plus matching generated report and ad CSV", async () => {
    const response = await GET(new Request(`https://curvi.ai/api/jobs/${jobId}/pack`), { params: Promise.resolve({ id: jobId }) });
    expect(response.status).toBe(200);
    const files = await response.json() as Array<{ name: string; content: string }>;
    expect(files.map((f) => f.name)).toEqual(["meta/ads/feed_4x5/v1.jpg", "compliance-report.json", "ads/ads.csv"]);
    expect(JSON.parse(files[1].content).files).toHaveLength(1);
    expect(files[2].content).toContain("'=formula()");
    expect(fixture.opened).toHaveLength(1);
  });
  it("refuses before starting the ZIP if selected pixels are missing", async () => {
    fixture.missing = true;
    const response = await GET(new Request(`https://curvi.ai/api/jobs/${jobId}/pack`), { params: Promise.resolve({ id: jobId }) });
    expect(response.status).toBe(409);
    expect(fixture.opened).toHaveLength(0);
  });
});
