import { describe, expect, it } from "vitest";
import { boundingBoxOfMask, coverage, dilate, erode, feather } from "./mask";
import type { RawMask } from "./raw";

function squareMask(size: number, left: number, top: number, side: number): RawMask {
  const data = Buffer.alloc(size * size, 0);
  for (let y = top; y < top + side; y++) {
    for (let x = left; x < left + side; x++) {
      data[y * size + x] = 255;
    }
  }
  return { data, width: size, height: size };
}

describe("boundingBoxOfMask", () => {
  it("finds the tight box of a centered square", () => {
    const mask = squareMask(64, 16, 20, 24);
    expect(boundingBoxOfMask(mask)).toEqual({ left: 16, top: 20, width: 24, height: 24 });
  });

  it("returns null for an empty mask", () => {
    const mask: RawMask = { data: Buffer.alloc(64 * 64, 0), width: 64, height: 64 };
    expect(boundingBoxOfMask(mask)).toBeNull();
  });
});

describe("coverage", () => {
  it("measures the product share", () => {
    const mask = squareMask(64, 0, 0, 32);
    expect(coverage(mask)).toBeCloseTo((32 * 32) / (64 * 64), 6);
  });
});

describe("erode", () => {
  it("shrinks the product region on every side", async () => {
    const mask = squareMask(64, 16, 16, 24);
    const eroded = await erode(mask, 2);
    const box = boundingBoxOfMask(eroded);
    expect(box).not.toBeNull();
    expect(box!.left).toBeGreaterThan(16);
    expect(box!.top).toBeGreaterThan(16);
    expect(box!.width).toBeLessThan(24);
    expect(coverage(eroded)).toBeLessThan(coverage(mask));
  });

  it("keeps the interior at full value", async () => {
    const mask = squareMask(64, 16, 16, 24);
    const eroded = await erode(mask, 2);
    expect(eroded.data[28 * 64 + 28]).toBe(255);
  });
});

describe("dilate", () => {
  it("grows the product region", async () => {
    const mask = squareMask(64, 24, 24, 12);
    const grown = await dilate(mask, 3);
    expect(coverage(grown)).toBeGreaterThan(coverage(mask));
    const box = boundingBoxOfMask(grown);
    expect(box!.left).toBeLessThan(24);
  });
});

describe("feather", () => {
  it("produces intermediate values at the edge and keeps the deep interior solid", async () => {
    const mask = squareMask(96, 24, 24, 48);
    const soft = await feather(mask, 3);
    let hasIntermediate = false;
    for (let i = 0; i < soft.data.length; i++) {
      if (soft.data[i] > 10 && soft.data[i] < 245) {
        hasIntermediate = true;
        break;
      }
    }
    expect(hasIntermediate).toBe(true);
    expect(soft.data[48 * 96 + 48]).toBe(255);
  });
});
