import { beforeEach, describe, expect, it, vi } from "vitest";
import { unavailableComplianceReport, demoComplianceReport } from "@/lib/compliance-report";
import type { WorkspaceSummary } from "@/lib/services/types";

// The compliance report routes (readable view and PDF), with the service
// layer faked.

const JOB_ID = "00000000-0000-4000-8000-00000000a001";
const WORKSPACE: WorkspaceSummary = { id: "ws-1", name: "WS", plan: "starter", creditBalance: 10, role: "client" };

const fake = vi.hoisted(() => ({
  workspace: null as unknown,
  report: null as unknown,
  calls: [] as unknown[][],
}));

vi.mock("@/lib/services", () => ({
  isDbMode: () => false,
  getServices: () => ({
    getCurrentWorkspace: async () => fake.workspace,
    ensureWorkspace: async () => fake.workspace,
    getComplianceReport: async (...args: unknown[]) => {
      fake.calls.push(args);
      return fake.report;
    },
  }),
}));

import { GET as getReport } from "./[id]/compliance/route";
import { GET as getPdf } from "./[id]/compliance-report.pdf/route";

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

const meta = { jobId: JOB_ID, productTitle: "Copper kettle" };

beforeEach(() => {
  fake.workspace = WORKSPACE;
  fake.report = demoComplianceReport(meta, [{ name: "demo.MAIN.jpg", specId: "amazon.main" }]);
  fake.calls = [];
});

describe("GET /api/jobs/:id/compliance", () => {
  it("returns the readable report for the caller's workspace, client seats included", async () => {
    const response = await getReport(new Request("http://localhost"), ctx(JOB_ID));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.channels[0].files[0].file).toBe("demo.MAIN.jpg");
    expect(fake.calls[0]).toEqual(["ws-1", JOB_ID]);
  });

  it("answers 404 for a malformed id or a job outside the workspace, and 401 signed out", async () => {
    expect((await getReport(new Request("http://localhost"), ctx("nope"))).status).toBe(404);
    expect(fake.calls).toHaveLength(0);
    fake.report = null;
    expect((await getReport(new Request("http://localhost"), ctx(JOB_ID))).status).toBe(404);
    fake.workspace = null;
    expect((await getReport(new Request("http://localhost"), ctx(JOB_ID))).status).toBe(401);
  });
});

describe("GET /api/jobs/:id/compliance-report.pdf", () => {
  it("downloads the report as compliance-report.pdf", async () => {
    const response = await getPdf(new Request("http://localhost"), ctx(JOB_ID));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="compliance-report.pdf"');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
    expect(Number(response.headers.get("content-length"))).toBe(bytes.length);
  });

  it("answers 409 with the reason while the report is not available", async () => {
    fake.report = unavailableComplianceReport(meta, "The compliance report is ready once the pack finishes.");
    const response = await getPdf(new Request("http://localhost"), ctx(JOB_ID));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("once the pack finishes");
  });

  it("answers 404 and 401 like the other job routes", async () => {
    expect((await getPdf(new Request("http://localhost"), ctx("nope"))).status).toBe(404);
    fake.report = null;
    expect((await getPdf(new Request("http://localhost"), ctx(JOB_ID))).status).toBe(404);
    fake.workspace = null;
    expect((await getPdf(new Request("http://localhost"), ctx(JOB_ID))).status).toBe(401);
  });
});
