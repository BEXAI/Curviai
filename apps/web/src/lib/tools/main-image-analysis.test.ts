import { describe, expect, it } from "vitest";
import { amazonMainRules } from "@/lib/marketing-facts";
import { checkRows, flattenOnWhite, measurePixels, summaryLine, type CheckerRules } from "./main-image-analysis";

const spec = amazonMainRules();
const rules: CheckerRules = {
  minLongSide: spec.minLongSide,
  fillMinPercent: spec.fillMinPercent,
  fillMaxPercent: spec.fillMaxPercent,
};

/** An RGBA canvas filled with one color, with a centered square of another. */
function canvas(
  size: number,
  background: [number, number, number, number],
  square: { side: number; color: [number, number, number, number] } | null,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4);
  const start = square ? Math.floor((size - square.side) / 2) : 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = square && x >= start && x < start + square.side && y >= start && y < start + square.side;
      const color = inside ? square.color : background;
      data.set(color, (y * size + x) * 4);
    }
  }
  return data;
}

describe("the checker reads its thresholds from the spec registry", () => {
  it("uses the amazon.main fill minimum and maximum (Update.md 6.10)", () => {
    expect(rules.fillMinPercent).toBe(85);
    expect(rules.fillMaxPercent).toBe(90);
  });
});

describe("transparent pixels (Update.md 6.9)", () => {
  it("composites transparent pixels on white, so a cutout is not read as black", () => {
    // A fully transparent frame whose raw rgb is black, around an opaque product.
    const data = canvas(100, [0, 0, 0, 0], { side: 88, color: [40, 90, 160, 255] });
    flattenOnWhite(data);
    const m = measurePixels(data, 100, 100);
    expect(m.borderWhiteShare).toBe(1);
    expect(m.fillRatio).toBeCloseTo(0.88, 5);
    const fill = checkRows({ width: 2000, height: 2000 }, m, rules).find((row) => row.key === "fill");
    expect(fill?.pass).toBe(true);
  });

  it("without flattening the same file would measure 100 percent fill", () => {
    const data = canvas(100, [0, 0, 0, 0], { side: 88, color: [40, 90, 160, 255] });
    expect(measurePixels(data, 100, 100).fillRatio).toBe(1);
  });

  it("blends half transparent pixels toward white", () => {
    const data = new Uint8ClampedArray([0, 0, 0, 128]);
    flattenOnWhite(data);
    expect(Array.from(data)).toEqual([127, 127, 127, 255]);
  });

  it("leaves opaque pixels untouched", () => {
    const data = new Uint8ClampedArray([10, 20, 30, 255]);
    flattenOnWhite(data);
    expect(Array.from(data)).toEqual([10, 20, 30, 255]);
  });
});

describe("fill range (Update.md 6.10)", () => {
  const white: [number, number, number, number] = [255, 255, 255, 255];
  const product: [number, number, number, number] = [30, 30, 30, 255];

  it("fails a product cropped tighter than the maximum", () => {
    const m = measurePixels(canvas(100, white, { side: 96, color: product }), 100, 100);
    const fill = checkRows({ width: 2000, height: 2000 }, m, rules).find((row) => row.key === "fill");
    expect(fill?.pass).toBe(false);
    expect(fill?.measured).toContain("too tight");
  });

  it("fails a product below the minimum", () => {
    const m = measurePixels(canvas(100, white, { side: 60, color: product }), 100, 100);
    const fill = checkRows({ width: 2000, height: 2000 }, m, rules).find((row) => row.key === "fill");
    expect(fill?.pass).toBe(false);
    expect(fill?.measured).toContain("small");
  });

  it("passes a product inside the range and names the range in the label", () => {
    const m = measurePixels(canvas(100, white, { side: 87, color: product }), 100, 100);
    const rows = checkRows({ width: 2000, height: 2000 }, m, rules);
    const fill = rows.find((row) => row.key === "fill");
    expect(fill?.pass).toBe(true);
    expect(fill?.label).toBe("Product fills 85 to 90 percent of the frame");
    expect(summaryLine(rows)).toBe("Passes all 3 checks");
  });

  it("measures fill against the longest frame side, like pipeline QC", () => {
    // 200 by 100 frame, product 170 wide and 60 tall: 170 / 200 = 0.85.
    const width = 200;
    const height = 100;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 20; y < 80; y++) {
      for (let x = 15; x < 185; x++) {
        data.set(product, (y * width + x) * 4);
      }
    }
    expect(measurePixels(data, width, height).fillRatio).toBeCloseTo(0.85, 5);
  });

  it("reports an all white image as having no product", () => {
    const m = measurePixels(canvas(50, white, null), 50, 50);
    expect(m.hasProduct).toBe(false);
    const rows = checkRows({ width: 500, height: 500 }, m, rules);
    expect(rows.find((row) => row.key === "fill")?.pass).toBe(false);
    expect(summaryLine(rows)).toBe("Fails 2 of 3 checks");
  });
});
