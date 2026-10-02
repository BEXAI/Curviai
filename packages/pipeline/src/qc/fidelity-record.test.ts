import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildPack, COMPLIANCE_REPORT_VERSION, type PackAsset } from "../packager/index";
import { encodeJpeg, encodePng } from "../raw";
import { paintRect, rawCanvas, rectMask } from "../testutil";
import { fidelityReport } from "./fidelity";
import {
  PRODUCT_UNCHANGED_CHECK,
  passthroughFidelity,
  productUnchangedCheck,
  readStoredFidelity,
  readStoredOutputProofs,
  storedFidelityOf,
  type StoredFidelity,
} from "./fidelity-record";

// P18-08: the fidelity numbers survive QC as a small rounded record, and
// the packager writes them into each file's report entry.

const record: StoredFidelity = {
  meanDeltaE: 0.84,
  maxDeltaE: 3.2,
  exactByteShare: 0.4123,
  maskArea: 52000,
  threshold: 3,
  maxDeltaELimit: 10,
  kind: "main",
  exact: false,
};

describe("storedFidelityOf", () => {
  it("rounds mean to 2 decimals, max to 1 and the exact share to 4", () => {
    expect(
      storedFidelityOf({
        meanDeltaE: 0.83671,
        maxDeltaE: 3.2449,
        exactByteShare: 0.412349,
        maskArea: 52000,
        threshold: 3,
        maxDeltaELimit: 10,
        kind: "main",
      }),
    ).toEqual(record);
  });

  it("keeps nothing from a report that compared no pixels or holds NaN", () => {
    const base = { meanDeltaE: 0, maxDeltaE: 0, exactByteShare: 0, maskArea: 0, threshold: 3, maxDeltaELimit: 10, kind: "main" as const };
    expect(storedFidelityOf(base)).toBeNull();
    expect(storedFidelityOf({ ...base, maskArea: 10, meanDeltaE: Number.NaN })).toBeNull();
    expect(storedFidelityOf(null)).toBeNull();
  });

  it("stores what a real report measured on a shifted product", async () => {
    const original = rawCanvas(64, 64, 255, 255, 255);
    paintRect(original, { left: 8, top: 8, width: 48, height: 48 }, 90, 120, 160);
    const shipped = rawCanvas(64, 64, 255, 255, 255);
    paintRect(shipped, { left: 8, top: 8, width: 48, height: 48 }, 91, 120, 160);
    const mask = rectMask(64, 64, { left: 8, top: 8, width: 48, height: 48 });
    const report = await fidelityReport(original, shipped, mask, { kind: "other" });
    const stored = storedFidelityOf(report);
    expect(stored).toMatchObject({ kind: "other", threshold: 5, exact: false, exactByteShare: 0 });
    expect(stored?.meanDeltaE).toBe(Math.round(report.meanDeltaE * 100) / 100);
    expect(stored?.maskArea).toBe(report.maskArea);
  });
});

describe("passthroughFidelity and the report row", () => {
  it("records a kept photo shipped byte for byte as exact", () => {
    expect(passthroughFidelity(2000 * 1500, { threshold: 3, maxDeltaELimit: 10 })).toEqual({
      meanDeltaE: 0,
      maxDeltaE: 0,
      exactByteShare: 1,
      maskArea: 3_000_000,
      threshold: 3,
      maxDeltaELimit: 10,
      kind: "main",
      exact: true,
    });
    expect(passthroughFidelity(0, { threshold: 3, maxDeltaELimit: 10 })).toBeNull();
  });

  it("writes the mean as measured and the threshold as the limit", () => {
    expect(productUnchangedCheck(record)).toEqual({
      name: PRODUCT_UNCHANGED_CHECK,
      pass: true,
      measured: 0.84,
      limit: "<= 3",
    });
    expect(productUnchangedCheck({ ...record, maxDeltaE: 10.5 }).pass).toBe(false);
  });
});

describe("readStoredFidelity", () => {
  it("reads a whole record back and refuses anything else", () => {
    expect(readStoredFidelity(JSON.parse(JSON.stringify(record)))).toEqual(record);
    expect(readStoredFidelity({ ...record, kind: "lifestyle" })).toBeNull();
    expect(readStoredFidelity({ ...record, meanDeltaE: "0.8" })).toBeNull();
    expect(readStoredFidelity(null)).toBeNull();
    expect(readStoredFidelity([record])).toBeNull();
  });

  it("reads stored output proofs leniently", () => {
    expect(
      readStoredOutputProofs([
        { specId: "amazon.main", fidelity: record, checks: [{ name: "fillRatio", pass: true, measured: 0.87, limit: "0.85 to 0.9" }] },
        { specId: "shopify.product", fidelity: null, checks: [{ name: 3 }] },
        { fidelity: record },
        "x",
      ]),
    ).toEqual([
      { specId: "amazon.main", fidelity: record, checks: [{ name: "fillRatio", pass: true, measured: 0.87, limit: "0.85 to 0.9" }] },
      { specId: "shopify.product", fidelity: null, checks: [] },
    ]);
    expect(readStoredOutputProofs(undefined)).toEqual([]);
  });
});

describe("buildPack writes the fidelity numbers", () => {
  async function mainAsset(fidelity: StoredFidelity | null): Promise<PackAsset> {
    const raw = rawCanvas(256, 256, 255, 255, 255);
    const box = { left: 12, top: 12, width: 224, height: 224 };
    paintRect(raw, box, 60, 60, 160);
    return {
      specId: "amazon.main",
      buffer: await encodeJpeg(raw),
      format: "jpg",
      raw,
      mask: rectMask(256, 256, box),
      sku: "ABC123",
      edgeMarginPx: 8,
      ref: "s1",
      fidelity,
    };
  }

  it("adds the fidelity entry and the product_unchanged row, and versions the report", async () => {
    const result = await buildPack([await mainAsset(record)], ["amazon"]);
    const file = result.report.files[0];
    expect(file.fidelity).toEqual(record);
    expect(file.checks.at(-1)).toEqual({ name: PRODUCT_UNCHANGED_CHECK, pass: true, measured: 0.84, limit: "<= 3" });
    expect(result.report.version).toBe(COMPLIANCE_REPORT_VERSION);
    const stored = JSON.parse(await readFile(result.reportPath, "utf8")) as { version: number; files: Array<{ fidelity?: unknown }> };
    expect(stored.version).toBe(2);
    expect(stored.files[0].fidelity).toEqual(record);
  });

  it("marks a file whose numbers are outside the limits as not passing", async () => {
    const result = await buildPack([await mainAsset({ ...record, meanDeltaE: 3.5 })], ["amazon"]);
    expect(result.report.files[0].pass).toBe(false);
  });

  it("writes no row for a file without numbers", async () => {
    const result = await buildPack([await mainAsset(null)], ["amazon"]);
    expect(result.report.files[0].fidelity).toBeUndefined();
    expect(result.report.files[0].checks.some((c) => c.name === PRODUCT_UNCHANGED_CHECK)).toBe(false);
  });

  it("leaves the numbers off a file the badge re-encoded after QC measured it", async () => {
    const size = 400;
    const box = { left: 120, top: 120, width: 160, height: 160 };
    const raw = rawCanvas(size, size, 236, 230, 220);
    paintRect(raw, box, 40, 90, 160);
    const asset: PackAsset = {
      specId: "meta.feed_1x1",
      buffer: await encodePng(raw),
      format: "png",
      mask: rectMask(size, size, box),
      badge: true,
      fidelity: record,
    };
    const result = await buildPack([asset], ["meta"]);
    const file = result.report.files[0];
    expect(file.badge).toBe(true);
    expect(file.fidelity).toBeUndefined();
    expect(file.checks.some((c) => c.name === PRODUCT_UNCHANGED_CHECK)).toBe(false);
    // Without the badge, the same file keeps its numbers.
    const plain = await buildPack([{ ...asset, badge: false }], ["meta"]);
    expect(plain.report.files[0].fidelity).toEqual(record);
  });
});
