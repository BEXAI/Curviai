import { describe, expect, it } from "vitest";
import {
  boxInCrop,
  boxToPixels,
  isolateTarget,
  maskComponents,
  significantComponents,
  targetCropRect,
  type PixelRect,
} from "./isolate";
import type { RawImage, RawMask } from "./raw";

/** Transparent RGBA canvas with opaque, per pixel varied rectangles, so a
 * byte identity check means something. */
function cutoutWith(size: number, rects: Array<PixelRect & { rgb: [number, number, number] }>): RawImage {
  const data = Buffer.alloc(size * size * 4, 0);
  for (const r of rects) {
    for (let y = r.top; y < r.top + r.height; y++) {
      for (let x = r.left; x < r.left + r.width; x++) {
        const o = (y * size + x) * 4;
        data[o] = (r.rgb[0] + x) % 256;
        data[o + 1] = (r.rgb[1] + y) % 256;
        data[o + 2] = r.rgb[2];
        data[o + 3] = x === r.left ? 128 : 255;
      }
    }
  }
  return { data, width: size, height: size, channels: 4 };
}

function pixel(img: RawImage, x: number, y: number): number[] {
  const o = (y * img.width + x) * 4;
  return [...img.data.subarray(o, o + 4)];
}

describe("box conversion", () => {
  it("turns a normalized box into whole pixels inside the image", () => {
    expect(boxToPixels({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 }, 200, 100)).toEqual({
      left: 50,
      top: 50,
      width: 100,
      height: 25,
    });
    // Never empty and never outside the image.
    expect(boxToPixels({ x: 1, y: 1, width: 0.001, height: 0.001 }, 10, 10)).toEqual({ left: 9, top: 9, width: 1, height: 1 });
  });

  it("crops to the box plus a tenth of its size on each side, clamped to the photo", () => {
    expect(targetCropRect({ x: 0.5, y: 0.2, width: 0.4, height: 0.5 }, 1000, 1000)).toEqual({
      left: 460,
      top: 150,
      width: 480,
      height: 600,
    });
    expect(targetCropRect({ x: 0, y: 0, width: 0.5, height: 1 }, 1000, 500)).toEqual({
      left: 0,
      top: 0,
      width: 550,
      height: 500,
    });
  });

  it("maps a box into a crop held at another size", () => {
    const crop = { left: 100, top: 50, width: 200, height: 100 };
    // The cutout came back at half size; the box runs past the crop's
    // bottom edge and is clamped to it.
    expect(boxInCrop({ x: 0.2, y: 0.1, width: 0.1, height: 0.1 }, { width: 1000, height: 1000 }, crop, { width: 100, height: 50 })).toEqual({
      left: 50,
      top: 25,
      width: 50,
      height: 25,
    });
    // A box wholly outside the crop has no place in it.
    expect(boxInCrop({ x: 0.8, y: 0.8, width: 0.1, height: 0.1 }, { width: 1000, height: 1000 }, crop, { width: 200, height: 100 })).toBeNull();
  });
});

describe("maskComponents", () => {
  it("joins diagonal neighbors (8 connectivity) and labels in row major order", () => {
    const data = Buffer.from([255, 0, 0, 0, 0, 255, 0, 255, 0, 0, 0, 0, 0, 0, 0, 255]);
    const mask: RawMask = { data, width: 4, height: 4 };
    const { components, labels } = maskComponents(mask);
    expect(components.map((c) => c.area)).toEqual([2, 1, 1]);
    expect(labels[0]).toBe(1);
    expect(labels[5]).toBe(1);
    expect(labels[7]).toBe(2);
    expect(labels[15]).toBe(3);
  });

  it("ignores pieces under half a percent of the image as noise", () => {
    const data = Buffer.alloc(100 * 100, 0);
    for (let y = 10; y < 40; y++) for (let x = 10; x < 40; x++) data[y * 100 + x] = 255;
    for (let y = 80; y < 86; y++) for (let x = 80; x < 86; x++) data[y * 100 + x] = 255; // 36 px < 50 px
    expect(significantComponents({ data, width: 100, height: 100 })).toHaveLength(1);
  });
});

describe("isolateTarget (rule 3)", () => {
  const red: [number, number, number] = [200, 20, 20];
  const blue: [number, number, number] = [20, 20, 200];

  it("keeps the target byte for byte and makes every other piece fully transparent", () => {
    const cutout = cutoutWith(100, [
      { left: 5, top: 10, width: 30, height: 80, rgb: red },
      { left: 60, top: 10, width: 30, height: 80, rgb: blue },
      { left: 45, top: 2, width: 3, height: 3, rgb: red }, // stray noise outside the target
    ]);
    const target = { left: 58, top: 8, width: 34, height: 84 };
    const result = isolateTarget(cutout, target, [{ left: 3, top: 8, width: 34, height: 84 }]);
    expect(result.touching).toBe(false);
    expect(result.kept).toBe(1);
    expect(result.removed).toBe(2);
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) {
        const insideBlue = x >= 60 && x < 90 && y >= 10 && y < 90;
        if (insideBlue) {
          expect(pixel(result.image, x, y)).toEqual(pixel(cutout, x, y));
        } else {
          expect(pixel(result.image, x, y)).toEqual([0, 0, 0, 0]);
        }
      }
    }
    // The input is never modified.
    expect(pixel(cutout, 10, 50)[3]).toBe(255);
  });

  it("keeps a cutout that is only the target exactly as it was", () => {
    const cutout = cutoutWith(64, [{ left: 10, top: 10, width: 40, height: 40, rgb: blue }]);
    const result = isolateTarget(cutout, { left: 8, top: 8, width: 44, height: 44 });
    expect(result.image.data.equals(cutout.data)).toBe(true);
    expect(result.touching).toBe(false);
  });

  it("flags products that touch, since one piece reaches into the other product's box", () => {
    const cutout = cutoutWith(100, [
      { left: 10, top: 10, width: 40, height: 80, rgb: red },
      { left: 50, top: 10, width: 40, height: 80, rgb: blue },
    ]);
    const result = isolateTarget(cutout, { left: 50, top: 10, width: 40, height: 80 }, [
      { left: 10, top: 10, width: 40, height: 80 },
    ]);
    expect(result.touching).toBe(true);
  });

  it("flags a second significant piece inside the target box", () => {
    const cutout = cutoutWith(100, [
      { left: 20, top: 10, width: 20, height: 80, rgb: red },
      { left: 60, top: 10, width: 20, height: 80, rgb: blue },
    ]);
    const result = isolateTarget(cutout, { left: 10, top: 5, width: 80, height: 90 });
    expect(result.touching).toBe(true);
  });
});
