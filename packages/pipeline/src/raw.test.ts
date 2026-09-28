import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { decodeMask, decodeToRgba, maskFromAlpha, normalizeOrientation } from "./raw";

/**
 * A 40x20 landscape frame, red on the left half and blue on the right,
 * stored with EXIF orientation 6 (the camera was turned a quarter turn
 * clockwise). Viewers show it as 20x40 portrait with red on top.
 */
async function sidewaysPhoto(): Promise<Buffer> {
  const width = 40;
  const height = 20;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      if (x < width / 2) {
        data[o] = 230;
      } else {
        data[o + 2] = 230;
      }
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 95 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

describe("EXIF orientation (Update.md wave 7 item 8)", () => {
  it("the fixture really carries orientation 6", async () => {
    const meta = await sharp(await sidewaysPhoto()).metadata();
    expect(meta.orientation).toBe(6);
    expect(meta.width).toBe(40);
    expect(meta.height).toBe(20);
  });

  it("decodeToRgba returns the photo upright", async () => {
    const img = await decodeToRgba(await sidewaysPhoto());
    expect(img.width).toBe(20);
    expect(img.height).toBe(40);
    const top = (2 * img.width + 10) * 4;
    const bottom = ((img.height - 3) * img.width + 10) * 4;
    // Red on top, blue at the bottom once turned upright.
    expect(img.data[top]).toBeGreaterThan(180);
    expect(img.data[top + 2]).toBeLessThan(60);
    expect(img.data[bottom + 2]).toBeGreaterThan(180);
    expect(img.data[bottom]).toBeLessThan(60);
  });

  it("decodes masks from the same tagged file at the same upright size", async () => {
    const photo = await sidewaysPhoto();
    const mask = await decodeMask(photo);
    const alpha = await maskFromAlpha(photo);
    expect([mask.width, mask.height]).toEqual([20, 40]);
    expect([alpha.width, alpha.height]).toEqual([20, 40]);
  });

  it("leaves untagged images unchanged", async () => {
    const png = await sharp({ create: { width: 30, height: 10, channels: 4, background: "#336699" } })
      .png()
      .toBuffer();
    const img = await decodeToRgba(png);
    expect([img.width, img.height]).toEqual([30, 10]);
    expect(await normalizeOrientation(png)).toBe(png);
  });

  it("normalizeOrientation bakes the rotation into the pixels and drops the tag", async () => {
    const upright = await normalizeOrientation(await sidewaysPhoto());
    const meta = await sharp(upright).metadata();
    expect(meta.width).toBe(20);
    expect(meta.height).toBe(40);
    expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);
    // Decoding the normalized bytes gives the same upright frame.
    const img = await decodeToRgba(upright);
    expect(img.data[(2 * img.width + 10) * 4]).toBeGreaterThan(180);
  });
});
