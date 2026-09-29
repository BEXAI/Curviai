/**
 * Channel packager (CURVI_BUILD_PLAN.md section 5.7): one zip per channel with
 * spec compliant file names plus compliance-report.json listing, per file, the
 * spec id, checks run, pass or fail and measured values. Marketplace bound
 * files are never watermarked (badge only where badgeAllowed and never on a
 * marketplace spec). A requested badge is drawn onto the file in a corner
 * clear of the product (./badge), or left off with a note. Files that carry a digitalSource kind get their IPTC
 * DigitalSourceType written before zipping, so delivered bytes are tagged
 * (plan 5.7.2). A PDF version of the report is a follow up; JSON ships now.
 *
 * Defensive limits (Update.md 2.10 and 2.12): a spec never gets more files
 * than channelFileLimit allows (8 amazon.secondary, 1 amazon.main), and no
 * two files in one zip share a name. The first asset wins; later ones are
 * left out of the zip, the loose files and report.files, and listed in
 * report.dropped instead, so a runner that charges only the refs present in
 * report.files never charges for them.
 */
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import archiver from "archiver";
import sharp from "sharp";
import { channelFileLimit, filenameFor, getSpec, isMarketplaceSpec, type ChannelSpec } from "@curvi/specs";
import { writeDigitalSourceType, type DigitalSourceKind } from "../metadata/iptc";
import { decodeToRgba } from "../raw";
import { headerChecks, pixelChecks, type CheckItem, type PixelCheckReport } from "../qc/pixelChecks";
import type { RawImage, RawMask } from "../raw";
import { treatmentNotes, type PackAssetTreatment } from "../treatment";
import { applyBadge } from "./badge";

export { applyBadge, badgeEligible, badgePlacement, renderBadge, type BadgeBox, type BadgeOutcome } from "./badge";

export interface PackAsset {
  /** Channel spec this file targets, e.g. "amazon.main". */
  specId: string;
  /** Encoded file bytes. */
  buffer: Buffer;
  /** File format, e.g. "jpg" or "png". Detected from the buffer when omitted. */
  format?: string;
  /** Raw pixels and mask enable the full deterministic checks. */
  raw?: RawImage;
  mask?: RawMask;
  /**
   * Decodes the pixels and mask on demand when raw is not supplied, called
   * with the exact bytes that ship (after IPTC tagging). Lets a caller hand
   * over many files holding only their encoded bytes: each file is decoded
   * when it is checked and released before the next, instead of every
   * decoded canvas staying in memory until packaging. A loader that throws
   * leaves that file with the file level checks.
   */
  loadPixels?: (bytes: Buffer) => Promise<{ raw: RawImage; mask?: RawMask }>;
  sku?: string;
  seoSlug?: string;
  /** Sequence number for {nn} and {n} naming slots. */
  n?: number;
  /** Whether the "Made with Curvi" badge was requested for this asset. It is
   * drawn only on a badgeAllowed social spec, clear of the product mask. */
  badge?: boolean;
  /** Margin passed to the background check, see PixelCheckOptions. */
  edgeMarginPx?: number;
  /** Caller reference (the shot id) carried into the report, so persistence
   * layers can link delivered files back to their asset rows. */
  ref?: string;
  /** IPTC DigitalSourceType to embed: "composite" for composited scenes,
   * "trained" for fully generated images, "none" or omitted for deterministic
   * edits of the user's photo (plan 5.7.2). */
  digitalSource?: DigitalSourceKind;
  /** What was done to the file's background and pixels (PHASE_15). Its
   * machine notes go into the report. A kept photo (original or unchanged)
   * and an already white file never carry the badge (founder decision 6),
   * and an unchanged file is checked from its header only. */
  treatment?: PackAssetTreatment;
  /** The ads format group the file belongs to (PHASE_16 workstream 3): a
   * carousel slide ships as carousel/NN, an ad variant under
   * ads/{placement}/, and the ad copy goes into that zip's ads CSV. */
  group?: PackGroup;
}

/** Where an ads format file sits in its channel's pack (PHASE_16 workstream 3). */
export type PackGroup =
  | { kind: "carousel"; carouselId: string; slideIndex: number }
  | { kind: "ad"; variantKey: string; headline: string; cta: string };

/** The CSV of headlines and calls to action each zip with ad variants carries. */
export const ADS_CSV_NAME = "ads/ads.csv";

/**
 * The pack group of a planned shot: carousel slides and ad variants get
 * one, every other shot none. The runner passes it with each file.
 */
export function packGroupFor(shot: {
  type: string;
  carouselId?: string;
  slideIndex?: number;
  variantKey?: string;
  headline?: string;
  cta?: string;
}): PackGroup | undefined {
  if (shot.type === "carousel_slide" && shot.carouselId && shot.slideIndex) {
    return { kind: "carousel", carouselId: shot.carouselId, slideIndex: shot.slideIndex };
  }
  if (shot.type === "ad_variant" && shot.variantKey) {
    return { kind: "ad", variantKey: shot.variantKey, headline: shot.headline ?? "", cta: shot.cta ?? "" };
  }
  return undefined;
}

/** A path segment safe inside a zip: letters, digits, dot, dash and underscore. */
function zipSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "").replace(/^\.+/, "");
  return cleaned === "" ? "file" : cleaned;
}

/** The placement folder of an ad file: the spec id without its family, "feed_4x5". */
export function adPlacementFolder(specId: string): string {
  return zipSegment(specId.split(".").slice(1).join("_") || specId);
}

/**
 * A grouped file's name inside its channel zip: carousel/01.jpg for the
 * first carousel (carousel-{id}/01.jpg for another), ads/{placement}/v1.jpg
 * for an ad variant. Null for a file with no group.
 */
export function groupedFileName(specId: string, group: PackGroup | undefined, format: string): string | null {
  if (!group) {
    return null;
  }
  const ext = extensionFor(format);
  if (group.kind === "carousel") {
    const folder = group.carouselId === "c1" ? "carousel" : `carousel-${zipSegment(group.carouselId)}`;
    return `${folder}/${String(group.slideIndex).padStart(2, "0")}.${ext}`;
  }
  return `ads/${adPlacementFolder(specId)}/${zipSegment(group.variantKey)}.${ext}`;
}

/** One CSV field, quoted when it holds a comma, quote or line break. A field
 * a spreadsheet would read as a formula (=, +, -, @ first) gets a leading
 * apostrophe, so opening the CSV never runs anything. */
function csvField(raw: string): string {
  const value = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** The ads CSV: one row per ad file with its placement, file, headline and call to action. */
export function adsCsv(rows: ReadonlyArray<{ specId: string; file: string; headline: string; cta: string }>): string {
  const lines = [["placement", "file", "headline", "call_to_action"].join(",")];
  for (const row of rows) {
    lines.push([row.specId, row.file, row.headline, row.cta].map(csvField).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** Kept photos and already white files ship the seller's own pixels, so the
 * packager never draws the badge on them. */
function keepsSellerPixels(treatment: PackAssetTreatment | undefined): boolean {
  return treatment?.kind === "original" || treatment?.kind === "original_unchanged" || treatment?.alreadyWhite === true;
}

export interface PackFileReport {
  file: string;
  channel: string;
  specId: string;
  ref: string | null;
  digitalSource: DigitalSourceKind;
  badge: boolean;
  notes: string[];
  checks: CheckItem[];
  /** The ads format group, for carousel slides and ad variants. */
  group?: PackGroup;
  measured: Pick<
    PixelCheckReport,
    "width" | "height" | "longestSide" | "backgroundWhiteShare" | "fillRatio" | "bytes" | "format"
  > | null;
  pass: boolean;
}

/** An asset the packager left out of the pack, and why. */
export interface PackDroppedAsset {
  /** The file name it would have had. */
  file: string;
  channel: string;
  specId: string;
  ref: string | null;
  reason: string;
}

export interface PackResult {
  outDir: string;
  zips: Array<{ channel: string; path: string; files: string[] }>;
  reportPath: string;
  report: {
    generatedAt: string;
    channels: string[];
    files: PackFileReport[];
    /** Assets left out for a channel file limit or a duplicate name. Never delivered, never charged. */
    dropped: PackDroppedAsset[];
    /** The seller intent the pack enforced, when a product was isolated. */
    intent?: PackIntent;
    /** What the product inventory found in each photo, when it ran. */
    inventory?: PackInventoryPhoto[];
  };
}

/** What the pack featured and removed at the seller's request
 * (docs/phases/PHASE_13.md item 6), listed in the compliance report. */
export interface PackIntent {
  featured: string[];
  removed: string[];
}

/** One piece the product inventory found in a photo, as the compliance
 * report lists it: featured, removed from every image, or kept (an in the
 * box photo, or a photo used whole). */
export interface PackInventoryItem {
  label: string;
  color: string;
  shape: string;
  status: "featured" | "removed" | "kept";
}

/** The inventory of one photo, numbered from 1 in the pack's photo order. */
export interface PackInventoryPhoto {
  photo: number;
  items: PackInventoryItem[];
  /** When the vision picker chose the featured product: "Picked by looking
   * at the photo: " and its short reason. */
  picked?: string;
}

/** Channel family of a spec id: "amazon.main" belongs to "amazon". */
export function channelOf(specId: string): string {
  return specId.split(".")[0];
}

export interface BuildPackOptions {
  /** Output directory. A fresh temp dir is created when omitted. */
  outDir?: string;
  /** Also write each delivered file loose under outDir/files/{channel}/{name},
   * so persistence layers can upload individual files, not only zips. */
  writeFiles?: boolean;
  /** The seller intent the pack enforced, written into every report. */
  intent?: PackIntent | null;
  /** The product inventory of the pack's photos, written into every report. */
  inventory?: PackInventoryPhoto[] | null;
}

export async function buildPack(
  assets: PackAsset[],
  channels: string[],
  opts: BuildPackOptions = {},
): Promise<PackResult> {
  const outDir = opts.outDir ?? (await mkdtemp(path.join(tmpdir(), "curvi-pack-")));

  const fileReports: PackFileReport[] = [];
  const dropped: PackDroppedAsset[] = [];
  const byChannel = new Map<string, Array<{ name: string; buffer: Buffer }>>();
  const counters = new Map<string, number>();
  const filesPerSpec = new Map<string, number>();
  const namesPerChannel = new Map<string, Set<string>>();

  for (const asset of assets) {
    const spec = getSpec(asset.specId);
    const channel = channelOf(asset.specId);
    if (!channels.includes(channel)) {
      continue;
    }

    const notes: string[] = treatmentNotes(asset.treatment);
    // Badges never touch marketplace bound files, and never a kept photo
    // (skipped with no note).
    let badge = asset.badge === true && !keepsSellerPixels(asset.treatment);
    if (badge && (isMarketplaceSpec(asset.specId) || spec.badgeAllowed !== true)) {
      badge = false;
      notes.push("badge suppressed: not allowed for this channel spec");
    }

    const format = asset.format ?? (await detectFormat(asset.buffer));
    const limit = channelFileLimit(spec);
    const already = filesPerSpec.get(asset.specId) ?? 0;
    if (limit !== null && already >= limit) {
      dropped.push({
        file: fileNameFor(spec, asset, asset.n ?? already + 1, format),
        channel,
        specId: asset.specId,
        ref: asset.ref ?? null,
        reason: `channel image limit: ${asset.specId} takes at most ${limit} ${limit === 1 ? "image" : "images"}`,
      });
      continue;
    }
    const n = asset.n ?? nextN(counters, asset.specId);
    const name = groupedFileName(asset.specId, asset.group, format) ?? fileNameFor(spec, asset, n, format);
    const taken = namesPerChannel.get(channel) ?? new Set<string>();
    if (taken.has(name)) {
      dropped.push({
        file: name,
        channel,
        specId: asset.specId,
        ref: asset.ref ?? null,
        reason: `duplicate file name: ${name} is already in the ${channel} pack`,
      });
      continue;
    }
    taken.add(name);
    namesPerChannel.set(channel, taken);
    filesPerSpec.set(asset.specId, already + 1);

    // The badge goes on before IPTC tagging, since drawing it re-encodes the
    // file. Its mask comes from the asset, or from the pixel loader.
    let buffer = asset.buffer;
    let rawForChecks = asset.raw;
    if (badge) {
      let mask: RawMask | null = asset.mask ?? null;
      if (!mask && asset.loadPixels) {
        mask = (await asset.loadPixels(buffer).catch(() => null))?.mask ?? null;
      }
      const outcome = await applyBadge(buffer, format, asset.specId, mask);
      if (outcome.applied) {
        buffer = outcome.buffer;
        if (rawForChecks) {
          rawForChecks = await decodeToRgba(buffer);
        }
        notes.push("badge applied: Made with Curvi, clear of the product");
      } else {
        badge = false;
        notes.push(`badge left off: ${outcome.reason}`);
      }
    }

    // Embed the IPTC digital source marking before any bytes leave the
    // packager, so zips, loose files and checks all see the tagged file.
    const digitalSource: DigitalSourceKind = asset.digitalSource ?? "none";
    if (digitalSource !== "none") {
      const tagPath = path.join(outDir, `.tag-${randomUUID()}.${format}`);
      await writeFile(tagPath, buffer);
      await writeDigitalSourceType(tagPath, digitalSource);
      buffer = await readFile(tagPath);
      await rm(tagPath, { force: true });
      notes.push(`iptc digital source type: ${digitalSource}`);
    }
    if (opts.writeFiles) {
      const loosePath = path.join(outDir, "files", channel, name);
      await mkdir(path.dirname(loosePath), { recursive: true });
      await writeFile(loosePath, buffer);
    }

    let checks: CheckItem[] = [];
    let measured: PackFileReport["measured"] = null;
    let pass = true;
    const unchanged = asset.treatment?.kind === "original_unchanged";
    let pixels: { raw: RawImage; mask?: RawMask } | null =
      rawForChecks && !unchanged ? { raw: rawForChecks, mask: asset.mask } : null;
    if (!pixels && asset.loadPixels && !unchanged) {
      try {
        pixels = await asset.loadPixels(buffer);
      } catch {
        notes.push("raw pixels could not be decoded");
      }
    }
    if (pixels) {
      const report = await pixelChecks(pixels.raw, pixels.mask ?? null, spec, {
        encoded: { bytes: buffer.length, format },
        edgeMarginPx: asset.edgeMarginPx,
      });
      checks = report.checks;
      pass = report.pass;
      measured = {
        width: report.width,
        height: report.height,
        longestSide: report.longestSide,
        backgroundWhiteShare: report.backgroundWhiteShare,
        fillRatio: report.fillRatio,
        bytes: report.bytes,
        format: report.format,
      };
    } else if (unchanged) {
      // The stored bytes, proven by sha256 upstream: read the header only.
      const meta = await sharp(buffer).metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      checks = headerChecks(width, height, spec, { bytes: buffer.length, format });
      pass = checks.every((c) => c.pass);
      measured = {
        width,
        height,
        longestSide: Math.max(width, height),
        backgroundWhiteShare: null,
        fillRatio: null,
        bytes: buffer.length,
        format,
      };
    } else {
      const meta = await sharp(buffer).metadata();
      const bytesOk = !spec.maxBytes || buffer.length <= spec.maxBytes;
      const formatOk = !spec.formats || (spec.formats as readonly string[]).includes(format);
      checks = [
        {
          name: "bytes",
          pass: bytesOk,
          measured: buffer.length,
          limit: spec.maxBytes ? `<= ${spec.maxBytes}` : "none",
        },
        {
          name: "format",
          pass: formatOk,
          measured: format,
          limit: spec.formats ? spec.formats.join(", ") : "any",
        },
      ];
      pass = bytesOk && formatOk;
      measured = {
        width: meta.width ?? 0,
        height: meta.height ?? 0,
        longestSide: Math.max(meta.width ?? 0, meta.height ?? 0),
        backgroundWhiteShare: null,
        fillRatio: null,
        bytes: buffer.length,
        format,
      };
      notes.push("raw pixels not supplied; only file level checks ran");
    }

    fileReports.push({
      file: name,
      channel,
      specId: asset.specId,
      ref: asset.ref ?? null,
      digitalSource,
      badge,
      notes,
      checks,
      ...(asset.group ? { group: asset.group } : {}),
      measured,
      pass,
    });
    const entries = byChannel.get(channel) ?? [];
    entries.push({ name, buffer });
    byChannel.set(channel, entries);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    channels: [...byChannel.keys()],
    files: fileReports,
    dropped,
    ...(opts.intent ? { intent: opts.intent } : {}),
    ...(opts.inventory && opts.inventory.length > 0 ? { inventory: opts.inventory } : {}),
  };
  const reportPath = path.join(outDir, "compliance-report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  const zips: PackResult["zips"] = [];
  for (const [channel, entries] of byChannel) {
    const zipPath = path.join(outDir, `${channel}.zip`);
    const channelReport = {
      generatedAt: report.generatedAt,
      channel,
      files: fileReports.filter((f) => f.channel === channel),
      dropped: dropped.filter((d) => d.channel === channel),
      ...(opts.intent ? { intent: opts.intent } : {}),
      ...(report.inventory ? { inventory: report.inventory } : {}),
    };
    const adRows = fileReports
      .filter((f) => f.channel === channel && f.group?.kind === "ad")
      .map((f) => {
        const group = f.group as Extract<PackGroup, { kind: "ad" }>;
        return { specId: f.specId, file: f.file, headline: group.headline, cta: group.cta };
      });
    await writeZip(zipPath, [
      ...entries,
      ...(adRows.length > 0 ? [{ name: ADS_CSV_NAME, buffer: Buffer.from(adsCsv(adRows)) }] : []),
      { name: "compliance-report.json", buffer: Buffer.from(JSON.stringify(channelReport, null, 2)) },
    ]);
    zips.push({ channel, path: zipPath, files: entries.map((e) => e.name) });
  }

  return { outDir, zips, reportPath, report };
}

function fileNameFor(spec: ChannelSpec, asset: PackAsset, n: number, format: string): string {
  if (spec.naming) {
    try {
      // The naming templates carry a fixed extension; the file's real format
      // wins, so a PNG main image never ships named .jpg (Update.md 2.9).
      return withExtension(filenameFor(spec, { sku: asset.sku, seoSlug: asset.seoSlug, n }), format);
    } catch {
      // Fall through to the generic name when a naming variable is missing.
    }
  }
  return `${spec.id.replaceAll(".", "_")}_${String(n).padStart(2, "0")}.${extensionFor(format)}`;
}

function extensionFor(format: string): string {
  const lower = format.toLowerCase();
  return lower === "jpeg" ? "jpg" : lower;
}

/** Replaces a trailing file extension with the one matching the format. */
export function withExtension(name: string, format: string): string {
  const ext = extensionFor(format);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}.${ext}` : `${name}.${ext}`;
}

function nextN(counters: Map<string, number>, specId: string): number {
  const n = (counters.get(specId) ?? 0) + 1;
  counters.set(specId, n);
  return n;
}

async function detectFormat(buffer: Buffer): Promise<string> {
  const meta = await sharp(buffer).metadata();
  const f = meta.format ?? "bin";
  if (f === "jpeg") return "jpg";
  if (f === "tiff") return "tif";
  return f;
}

function writeZip(zipPath: string, entries: Array<{ name: string; buffer: Buffer }>): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 6 } });
    output.on("close", () => resolve());
    archive.on("error", (err) => reject(err));
    archive.pipe(output);
    for (const entry of entries) {
      archive.append(entry.buffer, { name: entry.name });
    }
    void archive.finalize();
  });
}
