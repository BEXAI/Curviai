import { describe, expect, it } from "vitest";
import { PASTE_ERODE_PX, PASTE_FEATHER_PX } from "../composite/index";
import { cloneRaw } from "../raw";
import { paintRect, rawCanvas, rectMask } from "../testutil";
import { deriveQcErodePx, fidelityReport } from "./fidelity";

const box = { left: 32, top: 32, width: 192, height: 192 };

describe("fidelityReport", () => {
  it("reports perfect fidelity for identical images", async () => {
    const original = rawCanvas(256, 256, 255, 255, 255);
    paintRect(original, box, 120, 80, 40);
    const mask = rectMask(256, 256, box);
    const report = await fidelityReport(original, cloneRaw(original), mask);
    expect(report.exactByteShare).toBe(1);
    expect(report.meanDeltaE).toBe(0);
    expect(report.pass).toBe(true);
    expect(report.maskArea).toBeGreaterThan(0);
    expect(report.inputMaskArea).toBe(192 * 192);
    expect(report.issues).toEqual([]);
  });

  it("defaults its erosion to strictly inside the composite pure paste region", async () => {
    // Invariant: QC erode >= paste erode P + ceil(paste feather F) + 1, so the
    // checked region never touches the feathered blend band.
    expect(deriveQcErodePx()).toBe(PASTE_ERODE_PX + Math.ceil(PASTE_FEATHER_PX) + 1);
    expect(deriveQcErodePx(0, 0)).toBe(1);
    const original = rawCanvas(256, 256, 255, 255, 255);
    paintRect(original, box, 120, 80, 40);
    const mask = rectMask(256, 256, box);
    const report = await fidelityReport(original, cloneRaw(original), mask);
    expect(report.erodePx).toBe(deriveQcErodePx());
  });

  it("regression: an emptied eroded mask fails instead of passing vacuously", async () => {
    // A 4 px thin product: the derived default erosion annihilates the mask.
    // The old code returned exactByteShare 1, meanDeltaE 0, pass true here.
    const thinBox = { left: 32, top: 126, width: 192, height: 4 };
    const original = rawCanvas(256, 256, 255, 255, 255);
    paintRect(original, thinBox, 120, 80, 40);
    const composed = rawCanvas(256, 256, 20, 255, 20); // entirely regenerated
    const mask = rectMask(256, 256, thinBox);
    const report = await fidelityReport(original, composed, mask);
    expect(report.inputMaskArea).toBeGreaterThan(0);
    expect(report.maskArea).toBe(0);
    expect(report.exactByteShare).toBe(0);
    expect(report.pass).toBe(false);
    expect(report.issues).toContain("eroded_mask_empty");
  });

  it("fails an entirely empty input mask", async () => {
    const original = rawCanvas(64, 64, 255, 255, 255);
    const mask = { data: Buffer.alloc(64 * 64, 0), width: 64, height: 64 };
    const report = await fidelityReport(original, cloneRaw(original), mask);
    expect(report.pass).toBe(false);
    expect(report.issues).toContain("input_mask_empty");
  });

  it("regression: a single extreme pixel fails on maxDeltaE even when the mean stays low", async () => {
    const original = rawCanvas(256, 256, 255, 255, 255);
    paintRect(original, box, 120, 80, 40);
    const composed = cloneRaw(original);
    // One wildly repainted pixel deep inside the QC region.
    paintRect(composed, { left: 128, top: 128, width: 1, height: 1 }, 255, 255, 255);
    const mask = rectMask(256, 256, box);
    const report = await fidelityReport(original, composed, mask, { kind: "main" });
    expect(report.meanDeltaE).toBeLessThan(report.threshold);
    expect(report.maxDeltaE).toBeGreaterThan(report.maxDeltaELimit);
    expect(report.pass).toBe(false);
    expect(report.issues).toEqual(["max_delta_e_exceeded"]);
  });

  it("ignores changes outside the eroded mask", async () => {
    const original = rawCanvas(256, 256, 255, 255, 255);
    paintRect(original, box, 120, 80, 40);
    const composed = cloneRaw(original);
    // Wreck the background and the outer 3 px of the product edge.
    paintRect(composed, { left: 0, top: 0, width: 256, height: 20 }, 0, 255, 0);
    paintRect(composed, { left: box.left, top: box.top, width: box.width, height: 2 }, 0, 255, 0);
    const mask = rectMask(256, 256, box);
    const report = await fidelityReport(original, composed, mask, { erodePx: 3 });
    expect(report.exactByteShare).toBe(1);
    expect(report.meanDeltaE).toBe(0);
  });

  it("fails main threshold on a strong color shift inside the mask", async () => {
    const original = rawCanvas(256, 256, 255, 255, 255);
    paintRect(original, box, 120, 80, 40);
    const composed = cloneRaw(original);
    paintRect(composed, box, 80, 120, 90);
    const mask = rectMask(256, 256, box);
    const report = await fidelityReport(original, composed, mask, { kind: "main" });
    expect(report.exactByteShare).toBe(0);
    expect(report.meanDeltaE).toBeGreaterThan(3);
    expect(report.pass).toBe(false);
  });

  it("applies the looser threshold for other stills", async () => {
    const original = rawCanvas(128, 128, 200, 100, 60);
    const composed = rawCanvas(128, 128, 204, 102, 62);
    const mask = rectMask(128, 128, { left: 16, top: 16, width: 96, height: 96 });
    const asMain = await fidelityReport(original, composed, mask, { kind: "main" });
    const asOther = await fidelityReport(original, composed, mask, { kind: "other" });
    expect(asMain.threshold).toBe(3.0);
    expect(asOther.threshold).toBe(5.0);
    expect(asMain.meanDeltaE).toBeCloseTo(asOther.meanDeltaE, 10);
  });

  it("throws on mismatched dimensions", async () => {
    const a = rawCanvas(64, 64, 0, 0, 0);
    const b = rawCanvas(32, 32, 0, 0, 0);
    const mask = rectMask(64, 64, { left: 0, top: 0, width: 64, height: 64 });
    await expect(fidelityReport(a, b, mask)).rejects.toThrow(/match/);
  });
});
