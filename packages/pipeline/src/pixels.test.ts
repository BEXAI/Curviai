import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { flatPixelsOnWhite } from "./pixels";

describe("flatPixelsOnWhite", () => {
  it("flattens transparency on white and bounds the size", async () => {
    const png = await sharp({
      create: { width: 2000, height: 1000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const pixels = await flatPixelsOnWhite(png, 500);
    expect(pixels.naturalWidth).toBe(2000);
    expect(pixels.naturalHeight).toBe(1000);
    expect(pixels.width).toBe(500);
    expect(pixels.height).toBe(250);
    expect(pixels.data.length).toBe(500 * 250 * 4);
    expect([...pixels.data.slice(0, 4)]).toEqual([255, 255, 255, 255]);
  });

  it("throws on bytes that are not an image", async () => {
    await expect(flatPixelsOnWhite(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  });
});
