import { describe, expect, it } from "vitest";
import { cloneRaw } from "../raw";
import { paintRect, rawCanvas, rectMask } from "../testutil";
import { fidelityReport } from "./fidelity";

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
