import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/csp-report/route";
import { CSP_REPORT_MAX_BYTES, parseCspReports, redactUrl, ReportLogBudget } from "./csp-report";

const legacyReport = {
  "csp-report": {
    "document-uri": "https://curvi.ai/app/jobs/123?token=secret#top",
    "blocked-uri": "https://evil.example/x.js?session=abc",
    "violated-directive": "script-src-elem",
    "effective-directive": "script-src-elem",
    "original-policy": "default-src 'self'",
    disposition: "report",
    "source-file": "https://curvi.ai/_next/static/chunk.js?v=1",
    "line-number": 12,
    "column-number": "7",
    "status-code": 200,
    "script-sample": "alert(document.cookie)",
  },
};

const reportingApiBatch = [
  {
    type: "csp-violation",
    age: 10,
    url: "https://curvi.ai/pricing",
    body: {
      documentURL: "https://curvi.ai/pricing?ref=mail",
      blockedURL: "inline",
      effectiveDirective: "style-src-attr",
      disposition: "report",
      sample: "color: red",
      lineNumber: 3,
      columnNumber: 9,
      statusCode: 200,
    },
  },
  { type: "deprecation", body: { id: "x" } },
];

afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as { __curviCspBudget?: unknown }).__curviCspBudget = undefined;
});

describe("parseCspReports", () => {
  it("normalizes a report-uri report and cuts queries, fragments and samples", () => {
    const [violation] = parseCspReports(JSON.stringify(legacyReport));
    expect(violation).toEqual({
      documentUrl: "https://curvi.ai/app/jobs/123",
      blockedUrl: "https://evil.example/x.js",
      directive: "script-src-elem",
      disposition: "report",
      sourceFile: "https://curvi.ai/_next/static/chunk.js",
      line: 12,
      column: 7,
      statusCode: 200,
    });
    expect(JSON.stringify(violation)).not.toContain("cookie");
  });

  it("keeps only csp-violation entries of a Reporting API batch", () => {
    const violations = parseCspReports(JSON.stringify(reportingApiBatch));
    expect(violations).toEqual([
      {
        documentUrl: "https://curvi.ai/pricing",
        blockedUrl: "inline",
        directive: "style-src-attr",
        disposition: "report",
        sourceFile: null,
        line: 3,
        column: 9,
        statusCode: 200,
      },
    ]);
  });

  it("returns nothing for junk", () => {
    expect(parseCspReports("not json")).toEqual([]);
    expect(parseCspReports("{}")).toEqual([]);
    expect(parseCspReports("[1, null, {\"type\":\"csp-violation\"}]")).toEqual([]);
  });

  it("redacts URLs and keeps keywords", () => {
    expect(redactUrl("eval")).toBe("eval");
    expect(redactUrl("data:image/png;base64,AAAA")).toBe("data:");
    expect(redactUrl("blob:https://curvi.ai/1234")).toBe("blob:");
    expect(redactUrl(42)).toBeNull();
  });
});

describe("ReportLogBudget", () => {
  it("logs up to the limit per window and reports the dropped count once", () => {
    let t = 0;
    const budget = new ReportLogBudget(3, 1000, () => t);
    expect(budget.take(2)).toEqual({ allowed: 2, droppedBefore: 0 });
    expect(budget.take(5)).toEqual({ allowed: 1, droppedBefore: 0 });
    t = 1000;
    expect(budget.take(1)).toEqual({ allowed: 1, droppedBefore: 4 });
    expect(budget.take(0)).toEqual({ allowed: 0, droppedBefore: 0 });
  });
});

function post(body: string, contentType = "application/csp-report"): NextRequest {
  return new NextRequest("http://localhost/api/csp-report", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

describe("POST /api/csp-report", () => {
  it("logs each violation as a structured line and answers 204", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await POST(post(JSON.stringify(legacyReport)));
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(warn.mock.calls[0][0]));
    expect(line).toMatchObject({ event: "csp_violation", directive: "script-src-elem", documentUrl: "https://curvi.ai/app/jobs/123" });

    const batch = await POST(post(JSON.stringify(reportingApiBatch), "application/reports+json"));
    expect(batch.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("refuses other content types and oversized bodies", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await POST(post("x", "text/plain"))).status).toBe(415);
    expect((await POST(post("x".repeat(CSP_REPORT_MAX_BYTES + 1)))).status).toBe(413);
    expect(warn).not.toHaveBeenCalled();
  });
});
