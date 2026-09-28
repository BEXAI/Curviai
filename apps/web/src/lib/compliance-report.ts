/**
 * Readable compliance report (docs/PENDING.md, batch 2). The packager writes
 * compliance-report.json with raw check names and limits such as
 * "backgroundWhiteShare >= 0.999"; this module turns it into plain spoken
 * rows for the pack page and the PDF download: what was checked, what was
 * measured, what the channel requires, and whether it passed. Pure, so the
 * page, the API route and the PDF share one wording, and it is unit tested
 * without storage.
 */

import { z } from "zod";
import { dimensionBounds, getSpec, hasSpec, type ChannelSpec } from "@curvi/specs";
import { specDisplayName } from "@/components/marketing/spec-slug";

// The stored report, read leniently: fields the view does not use may change
// without breaking the page.
const StoredCheck = z.object({
  name: z.string(),
  pass: z.boolean(),
  measured: z.union([z.number(), z.string(), z.null()]).optional(),
  limit: z.string().optional(),
});

const StoredFile = z.object({
  file: z.string(),
  channel: z.string(),
  specId: z.string(),
  digitalSource: z.string().optional(),
  notes: z.array(z.string()).optional(),
  checks: z.array(StoredCheck).default([]),
  pass: z.boolean(),
});

const StoredDropped = z.object({
  file: z.string(),
  channel: z.string(),
  specId: z.string(),
  reason: z.string(),
});

export const StoredComplianceReport = z.object({
  generatedAt: z.string().optional(),
  files: z.array(StoredFile),
  dropped: z.array(StoredDropped).optional(),
});

export type StoredComplianceReport = z.infer<typeof StoredComplianceReport>;

export interface ComplianceCheckView {
  /** The packager's check name, for tests and analytics. */
  key: string;
  label: string;
  pass: boolean;
  measured: string;
  required: string;
}

export interface ComplianceFileView {
  file: string;
  specId: string;
  specLabel: string;
  pass: boolean;
  checks: ComplianceCheckView[];
  /** Plain spoken notes, such as the AI label written into the file. */
  notes: string[];
}

export interface ComplianceChannelView {
  channel: string;
  title: string;
  files: ComplianceFileView[];
}

export interface ComplianceDroppedView {
  file: string;
  channelTitle: string;
  reason: string;
}

export interface ComplianceReportView {
  jobId: string;
  productTitle: string;
  /** False while the pack is not finished or its report is not stored. */
  available: boolean;
  /** True in demo mode, where the requirements show but nothing is measured. */
  demo: boolean;
  notice?: string;
  generatedAt: string | null;
  summary: { files: number; passed: number; needsAttention: number; leftOut: number };
  channels: ComplianceChannelView[];
  dropped: ComplianceDroppedView[];
}

export const NOT_MEASURED = "Not measured";

export const REPORT_NOT_READY = "The compliance report is ready once the pack finishes.";
export const REPORT_NOT_STORED =
  "The compliance report for this pack is not available on this server. Contact us and we will send it.";

/** "amazon" to "Amazon", "tiktokshop" to "TikTok Shop". */
export function channelTitle(channel: string): string {
  const names: Record<string, string> = {
    amazon: "Amazon",
    shopify: "Shopify",
    google: "Google",
    etsy: "Etsy",
    ebay: "eBay",
    walmart: "Walmart",
    tiktokshop: "TikTok Shop",
    meta: "Meta",
    pinterest: "Pinterest",
    video: "Video",
  };
  return names[channel] ?? channel.charAt(0).toUpperCase() + channel.slice(1);
}

function percent(value: number): string {
  const pct = value * 100;
  const rounded = Math.round(pct * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded} percent`;
}

function megabytes(bytes: number): string {
  if (bytes >= 1_000_000) {
    const mb = Math.round((bytes / 1_000_000) * 10) / 10;
    return `${mb} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

/** Sizes at or above this are the packager's "no limit" sentinel. */
const NO_LIMIT = 1_000_000_000;

/** "2000x2000" to "2000 x 2000 px". */
function pixelSize(text: string): string {
  return text.replace(/(\d+)x(\d+)/, "$1 x $2 px");
}

/**
 * A dimensions limit ("exactly 970x600" or "1x1 to 2000x2000") in words,
 * dropping the sides that carry no limit.
 */
function sizeRequirement(limit: string | undefined): string {
  const text = limit ?? "";
  const exact = /^exactly (\d+x\d+)$/.exec(text);
  if (exact) {
    return `exactly ${pixelSize(exact[1])}`;
  }
  const range = /^(\d+)x(\d+) to (\d+)x(\d+)$/.exec(text);
  if (!range) {
    return text;
  }
  const [minW, minH, maxW, maxH] = range.slice(1).map(Number);
  const noMin = minW <= 1 && minH <= 1;
  const noMax = maxW >= NO_LIMIT && maxH >= NO_LIMIT;
  if (noMin && noMax) {
    return "any size";
  }
  if (noMax) {
    return `at least ${minW} x ${minH} px`;
  }
  if (noMin) {
    return `at most ${maxW} x ${maxH} px`;
  }
  return `${minW} x ${minH} px to ${maxW} x ${maxH} px`;
}

/** A "min to max" pixel range in words. */
function pxRequirement(limit: string | undefined): string {
  const range = limitRange(limit);
  if (!range) {
    return limit ?? "";
  }
  if (range[1] >= NO_LIMIT) {
    return `at least ${range[0]} px`;
  }
  return `${range[0]} to ${range[1]} px`;
}

/** Reads a "<= 10000000" or ">= 0.999" limit as its number. */
function limitNumber(limit: string | undefined): number | null {
  const match = /(-?\d+(?:\.\d+)?)/.exec(limit ?? "");
  return match ? Number(match[1]) : null;
}

/** Reads an "a to b" limit as its two numbers. */
function limitRange(limit: string | undefined): [number, number] | null {
  const match = /(-?\d+(?:\.\d+)?)\s+to\s+(-?\d+(?:\.\d+)?)/.exec(limit ?? "");
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function measuredText(value: number | string | null | undefined, format: (n: number) => string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return format(value);
  }
  if (value === "mask missing") {
    return "Could not be measured";
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return NOT_MEASURED;
}

/** One stored check as a plain spoken row. */
export function describeCheck(check: z.infer<typeof StoredCheck>): ComplianceCheckView {
  const { name, pass, measured, limit } = check;
  switch (name) {
    case "dimensions":
      return {
        key: name,
        label: "Image size",
        pass,
        measured: typeof measured === "string" ? pixelSize(measured) : NOT_MEASURED,
        required: sizeRequirement(limit),
      };
    case "longestSide":
      return {
        key: name,
        label: "Longest side",
        pass,
        measured: measuredText(measured, (n) => `${n} px`),
        required: pxRequirement(limit),
      };
    case "backgroundWhiteShare": {
      const min = limitNumber(limit);
      return {
        key: name,
        label: "Pure white background",
        pass,
        measured: measuredText(measured, percent),
        required: min === null ? (limit ?? "") : min >= 1 ? "100 percent" : `at least ${percent(min)}`,
      };
    }
    case "fillRatio": {
      const range = limitRange(limit);
      return {
        key: name,
        label: "Product fill",
        pass,
        measured: measuredText(measured, percent),
        required: range ? `${percent(range[0])} to ${percent(range[1])}` : (limit ?? ""),
      };
    }
    case "bytes": {
      const max = limitNumber(limit);
      return {
        key: name,
        label: "File size",
        pass,
        measured: measuredText(measured, megabytes),
        required: max === null ? "no limit" : `at most ${megabytes(max)}`,
      };
    }
    case "format":
      return {
        key: name,
        label: "File format",
        pass,
        measured: typeof measured === "string" ? measured.toUpperCase() : NOT_MEASURED,
        required: (limit ?? "any").toUpperCase().replaceAll(",", ", ").replace(/\s+/g, " "),
      };
    default:
      return {
        key: name,
        label: name,
        pass,
        measured: measuredText(measured, (n) => String(Math.round(n * 1000) / 1000)),
        required: limit ?? "",
      };
  }
}

/** Packager notes as plain sentences. Notes it does not know are left out. */
export function describeNotes(notes: string[] | undefined, digitalSource: string | undefined): string[] {
  const out: string[] = [];
  if (digitalSource === "composite") {
    out.push("Labeled in the file as a scene composited around your real product.");
  } else if (digitalSource === "trained") {
    out.push("Labeled in the file as an AI generated image.");
  }
  for (const note of notes ?? []) {
    if (note.startsWith("badge suppressed")) {
      out.push("The share badge was left off because this channel does not allow it.");
    } else if (note.startsWith("raw pixels not supplied")) {
      out.push("Only the file size and format were checked for this file.");
    } else if (note.startsWith("raw pixels could not be decoded")) {
      out.push("The pixels could not be read, so only the file size and format were checked.");
    }
  }
  return out;
}

function droppedReason(entry: z.infer<typeof StoredDropped>): string {
  if (entry.reason.startsWith("channel image limit")) {
    const max = limitNumber(entry.reason.split("at most")[1]);
    const cap = max === null ? "its limit" : `${max} ${max === 1 ? "image" : "images"}`;
    return `${specDisplayName(entry.specId)} takes at most ${cap}, so this file was left out and not charged.`;
  }
  if (entry.reason.startsWith("duplicate file name")) {
    return "Another file in this channel already had this name, so this one was left out and not charged.";
  }
  return "Left out of the pack and not charged.";
}

function summarize(channels: ComplianceChannelView[], dropped: ComplianceDroppedView[]): ComplianceReportView["summary"] {
  const files = channels.flatMap((c) => c.files);
  const passed = files.filter((f) => f.pass).length;
  return { files: files.length, passed, needsAttention: files.length - passed, leftOut: dropped.length };
}

function groupByChannel(files: Array<ComplianceFileView & { channel: string }>): ComplianceChannelView[] {
  const byChannel = new Map<string, ComplianceFileView[]>();
  for (const { channel, ...file } of files) {
    const list = byChannel.get(channel) ?? [];
    list.push(file);
    byChannel.set(channel, list);
  }
  return [...byChannel.entries()].map(([channel, list]) => ({ channel, title: channelTitle(channel), files: list }));
}

/** The stored JSON as the readable view. Null when it is not a report. */
export function buildComplianceReportView(
  raw: unknown,
  meta: { jobId: string; productTitle: string },
): ComplianceReportView | null {
  const parsed = StoredComplianceReport.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const report = parsed.data;
  const channels = groupByChannel(
    report.files.map((file) => ({
      channel: file.channel,
      file: file.file,
      specId: file.specId,
      specLabel: specDisplayName(file.specId),
      pass: file.pass,
      checks: file.checks.map(describeCheck),
      notes: describeNotes(file.notes, file.digitalSource),
    })),
  );
  const dropped = (report.dropped ?? []).map((entry) => ({
    file: entry.file,
    channelTitle: channelTitle(entry.channel),
    reason: droppedReason(entry),
  }));
  return {
    ...meta,
    available: true,
    demo: false,
    generatedAt: report.generatedAt ?? null,
    summary: summarize(channels, dropped),
    channels,
    dropped,
  };
}

/** A report view that has nothing to show yet, with the reason. */
export function unavailableComplianceReport(
  meta: { jobId: string; productTitle: string },
  notice: string,
): ComplianceReportView {
  return {
    ...meta,
    available: false,
    demo: false,
    notice,
    generatedAt: null,
    summary: { files: 0, passed: 0, needsAttention: 0, leftOut: 0 },
    channels: [],
    dropped: [],
  };
}

/**
 * The checks a file gets on this spec, as the packager runs them, with
 * nothing measured. Demo packs store no files, so the demo report shows what
 * each file is held to without inventing measurements.
 */
export function specRequirementChecks(spec: ChannelSpec): ComplianceCheckView[] {
  const checks: Array<z.infer<typeof StoredCheck>> = [];
  const bounds = dimensionBounds(spec);
  const exact = bounds.minWidth === bounds.maxWidth && bounds.minHeight === bounds.maxHeight;
  checks.push({
    name: "dimensions",
    pass: true,
    measured: null,
    limit: exact
      ? `exactly ${bounds.maxWidth}x${bounds.maxHeight}`
      : `${bounds.minWidth}x${bounds.minHeight} to ${bounds.maxWidth}x${bounds.maxHeight}`,
  });
  checks.push({
    name: "longestSide",
    pass: true,
    measured: null,
    limit: `${Math.max(spec.minLongSide ?? 1, bounds.minLongSide)} to ${bounds.maxLongSide}`,
  });
  if (spec.background?.type === "solid" && spec.background.rgb) {
    checks.push({ name: "backgroundWhiteShare", pass: true, measured: null, limit: ">= 1" });
  }
  if (spec.fill) {
    checks.push({ name: "fillRatio", pass: true, measured: null, limit: `${spec.fill.min} to ${spec.fill.max}` });
  }
  if (spec.maxBytes) {
    checks.push({ name: "bytes", pass: true, measured: null, limit: `<= ${spec.maxBytes}` });
  }
  if (spec.formats) {
    checks.push({ name: "format", pass: true, measured: null, limit: spec.formats.join(", ") });
  }
  return checks.map(describeCheck);
}

/** The demo pack's report: every file with its channel's requirements. */
export function demoComplianceReport(
  meta: { jobId: string; productTitle: string },
  files: Array<{ name: string; specId: string }>,
): ComplianceReportView {
  const rows = files
    .filter((file) => hasSpec(file.specId))
    .map((file) => ({
      channel: file.specId.split(".")[0],
      file: file.name,
      specId: file.specId,
      specLabel: specDisplayName(file.specId),
      pass: true,
      checks: specRequirementChecks(getSpec(file.specId)),
      notes: [],
    }));
  const channels = groupByChannel(rows);
  return {
    ...meta,
    available: true,
    demo: true,
    notice: "Demo mode shows the checks each file gets. Real packs show the measured values.",
    generatedAt: null,
    summary: summarize(channels, []),
    channels,
    dropped: [],
  };
}
