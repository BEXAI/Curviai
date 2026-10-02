import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { BenchmarkManifest, prepareBenchmarkEvidence } from "./benchmark";

function manifest() {
  return {
    schemaVersion: 1, checkedOn: "2026-10-02", reviewedBy: "Fixture test",
    products: [{
      id: "fixture", name: "Generated test square", kind: "synthetic-fixture",
      permission: { basis: "synthetic", note: "Generated test fixture, not a seller product.", recordedOn: "2026-10-02", publishAuthorized: false },
      source: "source.png",
      shots: [{
        kind: "amazon-main", channel: "amazon.main", reference: "source.png", shipped: "shipped.png", mask: "mask.png",
        referenceTransform: "Test fixture at matching dimensions and placement.", erodePx: 0,
        reportedRun: { pipelineRevision: "0000000", completedAt: "2026-10-02T00:00:00Z", jobId: "test-only" },
      }],
    }],
  };
}

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "curvi-benchmark-test-"));
  directories.push(root);
  const photos = path.join(root, "photos");
  const output = path.join(root, "output");
  await mkdir(photos);
  const source = await sharp({ create: { width: 12, height: 12, channels: 3, background: { r: 120, g: 80, b: 40 } } }).png().toBuffer();
  const mask = await sharp({ create: { width: 12, height: 12, channels: 3, background: "white" } }).greyscale().png().toBuffer();
  await writeFile(path.join(photos, "source.png"), source);
  await writeFile(path.join(photos, "shipped.png"), source);
  await writeFile(path.join(photos, "mask.png"), mask);
  await writeFile(path.join(photos, "manifest.json"), JSON.stringify(manifest()));
  return { root, photos, output };
}

describe("benchmark evidence manifest", () => {
  it("keeps generated fixtures distinct and requires ownership or consent for real photos", () => {
    expect(BenchmarkManifest.safeParse(manifest()).success).toBe(true);
    const input = manifest();
    input.products[0].kind = "real-photo";
    expect(BenchmarkManifest.safeParse(input).success).toBe(false);
    input.products[0].permission.basis = "owned";
    expect(BenchmarkManifest.safeParse(input).success).toBe(true);
    input.products[0].permission.note = "";
    expect(BenchmarkManifest.safeParse(input).success).toBe(false);
  });

  it("rejects traversal, duplicate products/shots, unregistered channels and missing run evidence", () => {
    for (const source of ["../source.png", "/source.png", "a/../../source.png", ".env", "a\\source.png"]) {
      const input = manifest();
      input.products[0].source = source;
      expect(BenchmarkManifest.safeParse(input).success, source).toBe(false);
    }
    const duplicate = manifest();
    duplicate.products.push(duplicate.products[0]);
    expect(BenchmarkManifest.safeParse(duplicate).success).toBe(false);
    const shots = manifest();
    shots.products[0].shots.push(shots.products[0].shots[0]);
    expect(BenchmarkManifest.safeParse(shots).success).toBe(false);
    const channel = manifest();
    channel.products[0].shots[0].channel = "invented.channel";
    expect(BenchmarkManifest.safeParse(channel).success).toBe(false);
    const run = manifest();
    run.products[0].shots[0].reportedRun.jobId = "";
    expect(BenchmarkManifest.safeParse(run).success).toBe(false);
  });

  it("measures supplied full-size files, hashes provenance and never calls fixtures a real benchmark", async () => {
    const { photos, output } = await fixture();
    const report = await prepareBenchmarkEvidence(photos, output);
    expect(report).toMatchObject({ mode: "offline-supplied-artifacts", realProducts: 0, syntheticProducts: 1 });
    expect(report.publication.published).toBe(false);
    expect(report.publication.requiresHumanReview).toBe(true);
    expect(report.publication.evidenceGaps).toContain("Needs at least 10 real products; supplied 0.");
    expect(report.rows[0].metrics).toMatchObject({ meanDeltaE: 0, exactByteShare: 1, maskArea: 144 });
    expect(report.rows[0].sha256.source).toMatch(/^[a-f0-9]{64}$/);
    expect(report.rows[0].sha256.source).toBe(report.rows[0].sha256.shipped);
    expect((await readFile(path.join(output, report.rows[0].heatmap))).length).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(path.join(output, "report.json"), "utf8"))).toEqual(report);
    // A changed delivered image must change both provenance and measurements.
    const drift = await sharp({ create: { width: 12, height: 12, channels: 3, background: "white" } }).png().toBuffer();
    await writeFile(path.join(photos, "shipped.png"), drift);
    const changed = await prepareBenchmarkEvidence(photos, output);
    expect(changed.rows[0].metrics.pass).toBe(false);
    expect(changed.rows[0].metrics.meanDeltaE).toBeGreaterThan(1);
    expect(changed.rows[0].sha256.shipped).not.toBe(report.rows[0].sha256.shipped);
  });

  it("refuses symlinks outside the photo directory and empty comparison masks", async () => {
    const { root, photos, output } = await fixture();
    await writeFile(path.join(root, "outside.png"), await readFile(path.join(photos, "source.png")));
    await rm(path.join(photos, "shipped.png"));
    await symlink(path.join(root, "outside.png"), path.join(photos, "shipped.png"));
    await expect(prepareBenchmarkEvidence(photos, output)).rejects.toThrow("leaves photo directory");
    await rm(path.join(photos, "shipped.png"));
    await writeFile(path.join(photos, "shipped.png"), await readFile(path.join(photos, "source.png")));
    const empty = await sharp({ create: { width: 12, height: 12, channels: 3, background: "black" } }).greyscale().png().toBuffer();
    await writeFile(path.join(photos, "mask.png"), empty);
    await expect(prepareBenchmarkEvidence(photos, output)).rejects.toThrow("no valid product comparison region");
  });
});
