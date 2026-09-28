import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { SHARE_IMAGE_MAX_SIDE, shareImageJpeg } from "./share-image";

async function photoWithExif(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 120, g: 80, b: 40 } } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExifMerge({ IFD0: { Make: "PhoneCo", Model: "Secret Model" } })
    .toBuffer();
}

describe("shareImageJpeg", () => {
  it("strips every metadata block from the seller's photo", async () => {
    const input = await photoWithExif(400, 200);
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const output = await shareImageJpeg(input);
    const meta = await sharp(output).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    expect(output.includes(Buffer.from("Secret Model"))).toBe(false);
  });

  it("turns the photo upright from its orientation tag", async () => {
    // Orientation 6 means rotate 90 degrees, so 400 by 200 shows as 200 by 400.
    const meta = await sharp(await shareImageJpeg(await photoWithExif(400, 200))).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(400);
  });

  it("bounds the longest side and never enlarges", async () => {
    const big = await sharp({ create: { width: 4000, height: 1000, channels: 3, background: "#fff" } })
      .png()
      .toBuffer();
    const bigMeta = await sharp(await shareImageJpeg(big)).metadata();
    expect(bigMeta.width).toBe(SHARE_IMAGE_MAX_SIDE);
    const small = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#fff" } })
      .png()
      .toBuffer();
    expect((await sharp(await shareImageJpeg(small)).metadata()).width).toBe(300);
  });

  it("flattens transparency on white", async () => {
    const clear = await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();
    const { data } = await sharp(await shareImageJpeg(clear)).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(250);
  });
});
