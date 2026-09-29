import { describe, expect, it } from "vitest";
import { EDGE_RESTORE_MIN_ALPHA, restoreSourceEdgesRaw } from "./cutout-edges";

function image(pixels: number[][]) {
  return { width: pixels.length, height: 1, channels: 4 as const, data: Buffer.from(pixels.flat()) };
}

describe("restoreSourceEdgesRaw", () => {
  it("puts the photo's own color back on product pixels and keeps the service's alpha", () => {
    const cutout = image([
      [10, 10, 10, 255],
      [20, 20, 20, EDGE_RESTORE_MIN_ALPHA],
      [30, 30, 30, EDGE_RESTORE_MIN_ALPHA - 1],
      [40, 40, 40, 0],
    ]);
    const source = image([
      [200, 100, 50, 255],
      [201, 101, 51, 255],
      [202, 102, 52, 255],
      [203, 103, 53, 255],
    ]);
    const out = restoreSourceEdgesRaw(cutout, source);
    expect([...out.data]).toEqual([
      200, 100, 50, 255,
      201, 101, 51, EDGE_RESTORE_MIN_ALPHA,
      30, 30, 30, EDGE_RESTORE_MIN_ALPHA - 1,
      40, 40, 40, 0,
    ]);
    // The input cutout is not changed in place.
    expect(cutout.data[0]).toBe(10);
  });
});
