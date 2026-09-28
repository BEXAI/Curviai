/**
 * compliance-report.pdf: the readable compliance report as a small PDF,
 * written by hand so no PDF library ships with the app. It uses the PDF
 * standard Helvetica fonts (every viewer has them, nothing is embedded),
 * US Letter pages, uncompressed content streams and a byte exact xref table
 * (PDF 1.4, ISO 32000 section 7.5). Text is limited to printable ASCII:
 * accents are folded and anything else becomes a space, since the standard
 * fonts carry no glyphs beyond WinAnsi and the report copy is plain English.
 */

import type { ComplianceReportView } from "./compliance-report";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

type FontName = "regular" | "bold";

// Advance widths in 1/1000 em for ASCII 32 to 126 (Adobe Helvetica and
// Helvetica-Bold AFM metrics), used only to wrap lines.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
  556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
  260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611,
  556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389,
  280, 389, 584,
];

type Rgb = readonly [number, number, number];
const INK: Rgb = [0.11, 0.12, 0.14];
const MUTED: Rgb = [0.42, 0.44, 0.48];
const PASS: Rgb = [0.02, 0.47, 0.3];
const FAIL: Rgb = [0.72, 0.11, 0.11];

/** Printable ASCII only: accents folded, anything else a space. */
export function pdfSafeText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapePdfString(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function textWidth(text: string, font: FontName, size: number): number {
  const widths = font === "bold" ? HELVETICA_BOLD : HELVETICA;
  let total = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    total += widths[code - 32] ?? 556;
  }
  return (total * size) / 1000;
}

/** Greedy word wrap to maxWidth; a word longer than a line is split. */
export function wrapText(text: string, font: FontName, size: number, maxWidth: number): string[] {
  const words = pdfSafeText(text).split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, font, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) {
      lines.push(line);
    }
    let rest = word;
    while (textWidth(rest, font, size) > maxWidth && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && textWidth(rest.slice(0, cut), font, size) > maxWidth) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) {
    lines.push(line);
  }
  return lines;
}

interface TextOptions {
  font?: FontName;
  size?: number;
  color?: Rgb;
  indent?: number;
  /** Extra space above the block. */
  before?: number;
}

/** Collects drawing operators page by page, starting a page when one fills. */
class PageWriter {
  readonly pages: string[][] = [[]];
  private y = PAGE_HEIGHT - MARGIN;

  private get ops(): string[] {
    return this.pages[this.pages.length - 1];
  }

  private newPage(): void {
    this.pages.push([]);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  /** Starts a new page unless height more points fit on this one. */
  ensure(height: number): void {
    if (this.y - height < MARGIN) {
      this.newPage();
    }
  }

  space(points: number): void {
    this.y -= points;
  }

  text(content: string, opts: TextOptions = {}): void {
    const font = opts.font ?? "regular";
    const size = opts.size ?? 10;
    const indent = opts.indent ?? 0;
    const leading = Math.round(size * 1.35);
    const lines = wrapText(content, font, size, CONTENT_WIDTH - indent);
    if (opts.before) {
      this.space(opts.before);
    }
    for (const line of lines) {
      this.ensure(leading);
      this.y -= leading;
      this.draw(line, MARGIN + indent, this.y, font, size, opts.color ?? INK);
    }
  }

  /** Two cells on one line: left text and right aligned text. */
  row(left: string, right: string, opts: { indent?: number; size?: number; rightColor: Rgb; font?: FontName }): void {
    const size = opts.size ?? 9;
    const font = opts.font ?? "regular";
    const indent = opts.indent ?? 0;
    const leading = Math.round(size * 1.4);
    const rightText = pdfSafeText(right);
    const rightWidth = textWidth(rightText, "bold", size);
    const lines = wrapText(left, font, size, CONTENT_WIDTH - indent - rightWidth - 12);
    lines.forEach((line, index) => {
      this.ensure(leading);
      this.y -= leading;
      this.draw(line, MARGIN + indent, this.y, font, size, INK);
      if (index === 0) {
        this.draw(rightText, PAGE_WIDTH - MARGIN - rightWidth, this.y, "bold", size, opts.rightColor);
      }
    });
  }

  rule(): void {
    this.ensure(8);
    this.y -= 6;
    this.ops.push(`0.85 0.86 0.88 RG 0.6 w ${MARGIN} ${this.y} m ${PAGE_WIDTH - MARGIN} ${this.y} l S`);
  }

  private draw(text: string, x: number, y: number, font: FontName, size: number, color: Rgb): void {
    const fontRef = font === "bold" ? "F2" : "F1";
    this.ops.push(
      `BT ${color.join(" ")} rg /${fontRef} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${escapePdfString(text)}) Tj ET`,
    );
  }
}

function formatGenerated(iso: string | null): string | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}

function pdfDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(
    date.getUTCMinutes(),
  )}${pad(date.getUTCSeconds())}Z`;
}

/** Lays the report out on pages. Exported for tests. */
export function layoutComplianceReport(report: ComplianceReportView): string[][] {
  const w = new PageWriter();
  w.text("Compliance report", { font: "bold", size: 20 });
  w.text(report.productTitle, { size: 12, color: MUTED, before: 2 });
  const generated = formatGenerated(report.generatedAt);
  if (generated) {
    w.text(`Checked on ${generated}`, { size: 9, color: MUTED });
  }
  const { files, passed, needsAttention, leftOut } = report.summary;
  const summary = [
    `${files} ${files === 1 ? "file" : "files"} checked.`,
    `${passed} passed every check.`,
    needsAttention > 0 ? `${needsAttention} need attention.` : null,
    leftOut > 0 ? `${leftOut} left out of the pack and not charged.` : null,
  ]
    .filter(Boolean)
    .join(" ");
  w.text(summary, { size: 11, before: 10 });
  if (report.notice) {
    w.text(report.notice, { size: 9, color: MUTED, before: 4 });
  }
  w.text(
    "Each file was measured against the published image rules of its channel. Your product pixels are never regenerated.",
    { size: 9, color: MUTED, before: 4 },
  );

  for (const channel of report.channels) {
    w.ensure(60);
    w.text(channel.title, { font: "bold", size: 14, before: 18 });
    w.rule();
    for (const file of channel.files) {
      w.ensure(40);
      w.space(6);
      w.row(`${file.file}  (${file.specLabel})`, file.pass ? "Pass" : "Needs attention", {
        font: "bold",
        size: 10,
        rightColor: file.pass ? PASS : FAIL,
      });
      for (const check of file.checks) {
        w.row(
          `${check.label}: ${check.measured}. Required: ${check.required}.`,
          check.measured === "Not measured" ? "" : check.pass ? "Pass" : "Fail",
          { indent: 12, rightColor: check.pass ? PASS : FAIL },
        );
      }
      for (const note of file.notes) {
        w.text(note, { size: 9, color: MUTED, indent: 12 });
      }
    }
  }

  if (report.dropped.length > 0) {
    w.ensure(60);
    w.text("Left out of the pack", { font: "bold", size: 14, before: 18 });
    w.rule();
    for (const entry of report.dropped) {
      w.text(`${entry.channelTitle}: ${entry.file}`, { font: "bold", size: 10, before: 6 });
      w.text(entry.reason, { size: 9, indent: 12 });
    }
  }
  return w.pages;
}

/** The report as PDF bytes. */
export function renderComplianceReportPdf(report: ComplianceReportView, now: Date = new Date()): Buffer {
  const pages = layoutComplianceReport(report);
  // Object numbers: 1 catalog, 2 pages tree, 3 and 4 fonts, 5 info, then a
  // page object and its content stream for each page.
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 6 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objects[5] = `<< /Title (${escapePdfString(pdfSafeText(`Compliance report, ${report.productTitle}`))}) /Producer (Curvi) /CreationDate (${pdfDate(now)}) >>`;
  pages.forEach((ops, index) => {
    const pageId = pageIds[index];
    const footer = `BT ${MUTED.join(" ")} rg /F1 8 Tf ${MARGIN} 30 Td (${escapePdfString(
      `Curvi compliance report, page ${index + 1} of ${pages.length}`,
    )}) Tj ET`;
    const stream = [...ops, footer].join("\n");
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });

  let body = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(body, "latin1");
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, "latin1");
  const count = objects.length;
  body += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) {
    body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${count} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
