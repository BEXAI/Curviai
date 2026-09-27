import { describe, expect, it } from "vitest";
import { ciede2000, hexToRgb, rgbToLab } from "./color";

/**
 * Reference pairs from the Sharma, Wu and Dalal 2005 CIEDE2000 test dataset.
 * Each entry: [L1, a1, b1, L2, a2, b2, expected dE2000].
 */
const SHARMA_2005_PAIRS: Array<[number, number, number, number, number, number, number]> = [
  [50.0, 2.6772, -79.7751, 50.0, 0.0, -82.7485, 2.0425],
  [50.0, 3.1571, -77.2803, 50.0, 0.0, -82.7485, 2.8615],
  [50.0, 2.8361, -74.02, 50.0, 0.0, -82.7485, 3.4412],
  [50.0, -1.3802, -84.2814, 50.0, 0.0, -82.7485, 1.0],
  [50.0, 0.0, 0.0, 50.0, -1.0, 2.0, 2.3669],
  [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
  [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
  [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
];

describe("ciede2000", () => {
  it.each(SHARMA_2005_PAIRS)(
    "matches Sharma 2005 reference for (%f, %f, %f) vs (%f, %f, %f)",
    (L1, a1, b1, L2, a2, b2, expected) => {
      const measured = ciede2000({ L: L1, a: a1, b: b1 }, { L: L2, a: a2, b: b2 });
      expect(Math.abs(measured - expected)).toBeLessThan(0.01);
    },
  );

  it("is symmetric", () => {
    const p = { L: 50, a: 2.5, b: 0 };
    const q = { L: 73, a: 25, b: -18 };
    expect(ciede2000(p, q)).toBeCloseTo(ciede2000(q, p), 10);
  });

  it("is zero for identical colors", () => {
    const p = { L: 42.3, a: -12.9, b: 55.1 };
    expect(ciede2000(p, p)).toBe(0);
  });
});

describe("rgbToLab", () => {
  it("maps white to L 100, a 0, b 0", () => {
    const lab = rgbToLab(255, 255, 255);
    expect(lab.L).toBeCloseTo(100, 2);
    expect(lab.a).toBeCloseTo(0, 2);
    expect(lab.b).toBeCloseTo(0, 2);
  });

  it("maps black to L 0", () => {
    const lab = rgbToLab(0, 0, 0);
    expect(lab.L).toBeCloseTo(0, 4);
  });

  it("gives 254 gray a visible distance from white", () => {
    const d = ciede2000(rgbToLab(254, 254, 254), rgbToLab(255, 255, 255));
    expect(d).toBeGreaterThan(0);
  });
});

describe("hexToRgb", () => {
  it("parses #C4A265", () => {
    expect(hexToRgb("#C4A265")).toEqual({ r: 196, g: 162, b: 101 });
  });

  it("rejects malformed values", () => {
    expect(() => hexToRgb("C4A265")).toThrow();
    expect(() => hexToRgb("#XYZ123")).toThrow();
  });
});
