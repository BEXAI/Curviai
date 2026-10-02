/** Offline P18-17 evidence preparation. Supplied artifacts are measured, never
 * generated here. Consent/run metadata is the operator's declaration, not an
 * independent verification of ownership or the claimed pipeline run. */
import { createHash } from "node:crypto";
import { readFile, realpath, stat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { getSpec } from "@curvi/specs";
import { decodeMask, decodeToRgba } from "../src/raw";
import { fidelityReport } from "../src/qc/fidelity";
import { renderFidelityHeatmap } from "../src/qc/heatmap";
import { benchmarkPolicy } from "../src/seed/growth";

const imagePath = z.string().min(1).max(240).refine((value) =>
  !path.isAbsolute(value) && !value.includes("\\") &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
  /\.(png|jpe?g|webp)$/i.test(value), "Use a relative PNG, JPEG or WebP path inside the photo directory.");

export const BenchmarkManifest = z.strictObject({
  schemaVersion: z.literal(1),
  checkedOn: z.iso.date(),
  reviewedBy: z.string().trim().min(1).max(120),
  products: z.array(z.strictObject({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
    name: z.string().trim().min(1).max(160),
    kind: z.enum(["real-photo", "synthetic-fixture"]),
    permission: z.strictObject({
      basis: z.enum(["owned", "consented", "synthetic"]),
      note: z.string().trim().min(1).max(1000),
      recordedOn: z.iso.date(),
      publishAuthorized: z.boolean(),
    }),
    source: imagePath,
    shots: z.array(z.strictObject({
      kind: z.enum(["amazon-main", "lifestyle"]),
      channel: z.string().min(1).max(80),
      reference: imagePath,
      shipped: imagePath,
      mask: imagePath,
      // The reference must be the original product at the exact output size
      // and placement, before encoding. Comparing to the unaligned source is
      // invalid; the transform note documents how the artifact was prepared.
      referenceTransform: z.string().trim().min(1).max(1000),
      erodePx: z.number().int().min(0).max(1000),
      reportedRun: z.strictObject({
        pipelineRevision: z.string().regex(/^[a-f0-9]{7,40}$/),
        completedAt: z.iso.datetime(),
        jobId: z.string().trim().min(1).max(120),
      }),
    })).min(1).max(2),
    generalComparison: z.strictObject({
      modelDisplayed: z.string().trim().min(1).max(160),
      runOn: z.iso.date(),
      instruction: z.string().trim().min(1).max(6000),
      crop: imagePath,
    }).optional(),
  })).min(1).max(benchmarkPolicy.maxProducts),
}).superRefine((manifest, ctx) => {
  const ids = new Set<string>();
  manifest.products.forEach((product, index) => {
    if (ids.has(product.id)) ctx.addIssue({ code: "custom", message: "Product IDs must be unique.", path: ["products", index, "id"] });
    ids.add(product.id);
    if ((product.kind === "synthetic-fixture") !== (product.permission.basis === "synthetic")) {
      ctx.addIssue({ code: "custom", message: "Real photos require ownership or consent; synthetic fixtures must be labeled synthetic.", path: ["products", index, "permission"] });
    }
    const kinds = new Set<string>();
    product.shots.forEach((shot, shotIndex) => {
      if (kinds.has(shot.kind)) ctx.addIssue({ code: "custom", message: "Each shot kind may occur once per product.", path: ["products", index, "shots", shotIndex] });
      kinds.add(shot.kind);
      try {
        getSpec(shot.channel);
        if (shot.kind === "amazon-main" && shot.channel !== "amazon.main") throw new Error("main channel");
      } catch {
        ctx.addIssue({ code: "custom", message: "Use a registered channel and amazon.main for the Amazon main shot.", path: ["products", index, "shots", shotIndex, "channel"] });
      }
    });
  });
});

export type BenchmarkManifestInput = z.infer<typeof BenchmarkManifest>;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function inputFile(root: string, relative: string): Promise<Buffer> {
  const resolved = await realpath(path.join(root, relative));
  if (!resolved.startsWith(root + path.sep)) throw new Error(`Artifact leaves photo directory: ${relative}`);
  const file = await stat(resolved);
  if (!file.isFile() || file.size > benchmarkPolicy.maxImageBytes) throw new Error(`Artifact is not a bounded image file: ${relative}`);
  const bytes = await readFile(resolved);
  const metadata = await sharp(bytes, { limitInputPixels: benchmarkPolicy.maxImagePixels }).metadata();
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > benchmarkPolicy.maxImagePixels ||
    !["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1) {
    throw new Error(`Artifact must be a single bounded PNG, JPEG or WebP image: ${relative}`);
  }
  return bytes;
}

/** Measures full-size delivered files and writes local review artifacts only.
 * No provider or network dependency is invoked and nothing is published. */
export async function prepareBenchmarkEvidence(photoDirectory: string, outputDirectory: string) {
  const root = await realpath(photoDirectory);
  const manifestPath = await realpath(path.join(root, "manifest.json"));
  if (!manifestPath.startsWith(root + path.sep) || (await stat(manifestPath)).size > benchmarkPolicy.maxManifestBytes) {
    throw new Error("Manifest must be a bounded file inside the photo directory.");
  }
  const manifestBytes = await readFile(manifestPath);
  const manifest = BenchmarkManifest.parse(JSON.parse(manifestBytes.toString("utf8")));
  const rows = [];
  const gaps: string[] = [];
  const realCount = manifest.products.filter((product) => product.kind === "real-photo").length;
  if (realCount < benchmarkPolicy.minimumRealProducts) gaps.push(`Needs at least ${benchmarkPolicy.minimumRealProducts} real products; supplied ${realCount}.`);
  // Keep output names tied to validated IDs, with no implicit public paths.
  await mkdir(outputDirectory, { recursive: true });
  for (const product of manifest.products) {
    const source = await inputFile(root, product.source);
    if (!product.permission.publishAuthorized) gaps.push(`${product.id}: publication permission is not recorded.`);
    if (product.shots.length !== 2) gaps.push(`${product.id}: both main and lifestyle outputs are required.`);
    const comparison = product.generalComparison;
    if (!comparison) gaps.push(`${product.id}: dated general-model comparison crop and instruction are missing.`);
    const comparisonDigest = comparison ? digest(await inputFile(root, comparison.crop)) : null;
    for (const shot of product.shots) {
      const referenceBytes = await inputFile(root, shot.reference);
      const shippedBytes = await inputFile(root, shot.shipped);
      const maskBytes = await inputFile(root, shot.mask);
      const reference = await decodeToRgba(referenceBytes);
      const shipped = await decodeToRgba(shippedBytes);
      const mask = await decodeMask(maskBytes);
      const metrics = await fidelityReport(reference, shipped, mask, {
        kind: shot.kind === "amazon-main" ? "main" : "other", erodePx: shot.erodePx,
      });
      if (metrics.maskArea === 0 || !Number.isFinite(metrics.meanDeltaE) || !Number.isFinite(metrics.maxDeltaE)) {
        throw new Error(`${product.id}/${shot.kind}: no valid product comparison region.`);
      }
      const heatmap = `${product.id}-${shot.kind}.heatmap.png`;
      const heatmapBytes = await renderFidelityHeatmap(reference, shipped, mask, { erodePx: shot.erodePx });
      await writeFile(path.join(outputDirectory, heatmap), heatmapBytes);
      rows.push({
        productId: product.id, name: product.name, kind: product.kind,
        shot: shot.kind, channel: shot.channel, reportedRun: shot.reportedRun,
        referenceTransform: shot.referenceTransform, metrics, heatmap,
        files: { source: product.source, reference: shot.reference, shipped: shot.shipped, mask: shot.mask },
        generalComparison: comparison ?? null,
        sha256: { source: digest(source), reference: digest(referenceBytes), shipped: digest(shippedBytes), mask: digest(maskBytes), heatmap: digest(heatmapBytes), comparison: comparisonDigest },
      });
    }
  }
  const report = {
    schemaVersion: 1, mode: "offline-supplied-artifacts", checkedOn: manifest.checkedOn,
    reviewedBy: manifest.reviewedBy, manifestSha256: digest(manifestBytes),
    realProducts: realCount, syntheticProducts: manifest.products.length - realCount,
    publication: { published: false, evidenceGaps: gaps, requiresHumanReview: true },
    limits: "Measures RGB color differences inside the supplied eroded mask on aligned references and decoded delivered files. It does not verify label text, ownership, run metadata or general-model quality. Heatmap thumbnails may hide small differences; use the full-size metrics and files.",
    rows,
  };
  await writeFile(path.join(outputDirectory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}
