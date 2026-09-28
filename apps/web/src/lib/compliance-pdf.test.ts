import { describe, expect, it } from "vitest";
import { buildComplianceReportView, type ComplianceReportView } from "./compliance-report";
import { layoutComplianceReport, pdfSafeText, renderComplianceReportPdf, textWidth, wrapText } from "./compliance-pdf";

function report(files: number): ComplianceReportView {
  return buildComplianceReportView(
    {
      generatedAt: "2026-09-28T12:00:00.000Z",
      files: Array.from({ length: files }, (_, i) => ({
        file: `SKU1.PT${String(i + 1).padStart(2, "0")}.jpg`,
        channel: "amazon",
        specId: "amazon.secondary",
        notes: [],
        checks: [
          { name: "dimensions", pass: true, measured: "2000x2000", limit: "1x1 to 2000x2000" },
          { name: "bytes", pass: i % 2 === 0, measured: 900_000, limit: "<= 10000000" },
        ],
        pass: i % 2 === 0,
      })),
      dropped: [],
    },
    { jobId: "00000000-0000-4000-8000-00000000a001", productTitle: "Crème brûlée torch (café) \\ set" },
  )!;
}

describe("renderComplianceReportPdf", () => {
  it("writes a well formed PDF whose xref offsets point at each object", () => {
    const pdf = renderComplianceReportPdf(report(3), new Date("2026-09-28T12:00:00Z"));
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);

    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    const xref = text.slice(startxref).split("\n");
    const count = Number(xref[1].split(" ")[1]);
    for (let id = 1; id < count; id++) {
      const offset = Number(xref[2 + id].slice(0, 10));
      expect(text.slice(offset, offset + `${id} 0 obj`.length)).toBe(`${id} 0 obj`);
    }
    // Every stream's declared length matches its bytes.
    for (const match of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
      const start = match.index! + match[0].length;
      expect(text.slice(start + Number(match[1]), start + Number(match[1]) + 10)).toBe("\nendstream");
    }
  });

  it("carries the readable rows, the summary and a safe title", () => {
    const text = renderComplianceReportPdf(report(2)).toString("latin1");
    expect(text).toContain("(Compliance report) Tj");
    expect(text).toContain("Creme brulee torch \\(cafe\\) \\\\ set");
    expect(text).toContain("2 files checked. 1 passed every check. 1 need attention.");
    expect(text).toContain("Image size: 2000 x 2000 px. Required: at most 2000 x 2000 px.");
    expect(text).toContain("(Needs attention) Tj");
  });

  it("flows long reports onto more pages with a page count footer", () => {
    const pages = layoutComplianceReport(report(40));
    expect(pages.length).toBeGreaterThan(1);
    const text = renderComplianceReportPdf(report(40)).toString("latin1");
    expect(text).toContain(`/Count ${pages.length}`);
    expect(text).toContain(`page ${pages.length} of ${pages.length}`);
  });
});

describe("pdf text helpers", () => {
  it("folds accents and drops characters the standard fonts cannot draw", () => {
    expect(pdfSafeText("Café — “quoted” 😀")).toBe("Cafe quoted");
  });

  it("wraps to the width and splits a word longer than a line", () => {
    const lines = wrapText("word ".repeat(60), "regular", 10, 200);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => textWidth(line, "regular", 10) <= 200)).toBe(true);
    const long = wrapText("x".repeat(300), "bold", 10, 100);
    expect(long.every((line) => textWidth(line, "bold", 10) <= 100)).toBe(true);
    expect(long.join("")).toBe("x".repeat(300));
  });
});
