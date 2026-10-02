import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { cloneRaw } from "../raw";
import { rawCanvas, rectMask, paintRect } from "../testutil";
import { renderFidelityHeatmap } from "./heatmap";

describe("offline fidelity heatmap", () => {
  it("renders identical product pixels gray, dims the background and is deterministic", async () => {
    const image = rawCanvas(20, 20, 120, 80, 40);
    const mask = rectMask(20, 20, { left: 4, top: 4, width: 12, height: 12 });
    const output = await renderFidelityHeatmap(image, image, mask, { erodePx: 0 });
    expect(await renderFidelityHeatmap(image, image, mask, { erodePx: 0 })).toEqual(output);
    const pixels = await sharp(output).raw().toBuffer();
    const product = Array.from(pixels.subarray((10 * 20 + 10) * 3, (10 * 20 + 10) * 3 + 3));
    expect(new Set(product).size).toBe(1);
    expect(pixels[0]).toBeLessThan(product[0]);
  });

  it("colors a one-pixel label shift but excludes changes outside the eroded QC region", async () => {
    const reference = rawCanvas(20, 20, 255, 255, 255);
    paintRect(reference, { left: 10, top: 5, width: 1, height: 10 }, 0, 0, 0);
    const shifted = rawCanvas(20, 20, 255, 255, 255);
    paintRect(shifted, { left: 11, top: 5, width: 1, height: 10 }, 0, 0, 0);
    const mask = rectMask(20, 20, { left: 3, top: 3, width: 14, height: 14 });
    const pixels = await sharp(await renderFidelityHeatmap(reference, shifted, mask, { erodePx: 1 })).raw().toBuffer();
    const changed = Array.from(pixels.subarray((10 * 20 + 10) * 3, (10 * 20 + 10) * 3 + 3));
    expect(new Set(changed).size).toBeGreaterThan(1);
    const edgeOnly = cloneRaw(reference);
    paintRect(edgeOnly, { left: 3, top: 3, width: 1, height: 1 }, 0, 0, 0);
    expect(await renderFidelityHeatmap(reference, edgeOnly, mask, { erodePx: 1 }))
      .toEqual(await renderFidelityHeatmap(reference, reference, mask, { erodePx: 1 }));
  });

  it("caps the long side and refuses empty or malformed comparisons", async () => {
    const image = rawCanvas(700, 40, 10, 50, 80);
    const mask = rectMask(700, 40, { left: 0, top: 0, width: 700, height: 40 });
    const metadata = await sharp(await renderFidelityHeatmap(image, image, mask, { erodePx: 0 })).metadata();
    expect(metadata.width).toBe(600);
    expect(metadata.height).toBeLessThan(40);
    await expect(renderFidelityHeatmap(image, image, { ...mask, data: Buffer.alloc(mask.data.length) })).rejects.toThrow("empty");
    await expect(renderFidelityHeatmap(image, { ...image, data: Buffer.alloc(1) }, mask)).rejects.toThrow("aligned");
  });
});
