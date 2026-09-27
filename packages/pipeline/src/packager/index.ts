/**
 * Channel packager (CURVI_BUILD_PLAN.md section 5.7): one zip per channel with
 * spec compliant file names plus compliance-report.json listing, per file, the
 * spec id, checks run, pass or fail and measured values. Marketplace bound
 * files are never watermarked (badge only where badgeAllowed and never on a
 * marketplace spec). A PDF version of the report is a follow up; JSON ships now.
 */
import { createWriteStream } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import archiver from "archiver";
import sharp from "sharp";
import { filenameFor, getSpec, isMarketplaceSpec, type ChannelSpec } from "@curvi/specs";
import { pixelChecks, type CheckItem, type PixelCheckReport } from "../qc/pixelChecks";
import type { RawImage, RawMask } from "../raw";

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
  sku?: string;
  seoSlug?: string;
  /** Sequence number for {nn} and {n} naming slots. */
  n?: number;
  /** Whether a share badge was requested for this asset. */
  badge?: boolean;
  /** Margin passed to the background check, see PixelCheckOptions. */
  edgeMarginPx?: number;
}

export interface PackFileReport {
  file: string;
  channel: string;
  specId: string;
  badge: boolean;
  notes: string[];
  checks: CheckItem[];
  measured: Pick<
    PixelCheckReport,
    "width" | "height" | "longestSide" | "backgroundWhiteShare" | "fillRatio" | "bytes" | "format"
  > | null;
  pass: boolean;
}

export interface PackResult {
  outDir: string;
  zips: Array<{ channel: string; path: string; files: string[] }>;
  reportPath: string;
  report: { generatedAt: string; channels: string[]; files: PackFileReport[] };
}

/** Channel family of a spec id: "amazon.main" belongs to "amazon". */
export function channelOf(specId: string): string {
  return specId.split(".")[0];
}

export interface BuildPackOptions {
  /** Output directory. A fresh temp dir is created when omitted. */
  outDir?: string;
}

export async function buildPack(
  assets: PackAsset[],
  channels: string[],
  opts: BuildPackOptions = {},
): Promise<PackResult> {
  const outDir = opts.outDir ?? (await mkdtemp(path.join(tmpdir(), "curvi-pack-")));

  const fileReports: PackFileReport[] = [];
  const byChannel = new Map<string, Array<{ name: string; buffer: Buffer }>>();
  const counters = new Map<string, number>();

  for (const asset of assets) {
    const spec = getSpec(asset.specId);
    const channel = channelOf(asset.specId);
    if (!channels.includes(channel)) {
      continue;
    }

    const notes: string[] = [];
    // Badges never touch marketplace bound files.
    let badge = asset.badge === true;
    if (badge && (isMarketplaceSpec(asset.specId) || spec.badgeAllowed !== true)) {
      badge = false;
      notes.push("badge suppressed: not allowed for this channel spec");
    }

    const n = asset.n ?? nextN(counters, asset.specId);
    const format = asset.format ?? (await detectFormat(asset.buffer));
    const name = fileNameFor(spec, asset, n, format);

    let checks: CheckItem[] = [];
    let measured: PackFileReport["measured"] = null;
    let pass = true;
    if (asset.raw) {
      const report = await pixelChecks(asset.raw, asset.mask ?? null, spec, {
        encoded: { bytes: asset.buffer.length, format },
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
    } else {
      const meta = await sharp(asset.buffer).metadata();
      const bytesOk = !spec.maxBytes || asset.buffer.length <= spec.maxBytes;
      const formatOk = !spec.formats || (spec.formats as readonly string[]).includes(format);
      checks = [
        {
          name: "bytes",
          pass: bytesOk,
          measured: asset.buffer.length,
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
        bytes: asset.buffer.length,
        format,
      };
      notes.push("raw pixels not supplied; only file level checks ran");
    }

    fileReports.push({ file: name, channel, specId: asset.specId, badge, notes, checks, measured, pass });
    const entries = byChannel.get(channel) ?? [];
    entries.push({ name, buffer: asset.buffer });
    byChannel.set(channel, entries);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    channels: [...byChannel.keys()],
    files: fileReports,
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
    };
    await writeZip(zipPath, [
      ...entries,
      { name: "compliance-report.json", buffer: Buffer.from(JSON.stringify(channelReport, null, 2)) },
    ]);
    zips.push({ channel, path: zipPath, files: entries.map((e) => e.name) });
  }

  return { outDir, zips, reportPath, report };
}

function fileNameFor(spec: ChannelSpec, asset: PackAsset, n: number, format: string): string {
  if (spec.naming) {
    try {
      return filenameFor(spec, { sku: asset.sku, seoSlug: asset.seoSlug, n });
    } catch {
      // Fall through to the generic name when a naming variable is missing.
    }
  }
  return `${spec.id.replaceAll(".", "_")}_${String(n).padStart(2, "0")}.${format}`;
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
