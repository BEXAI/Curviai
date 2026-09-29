import { crc32 } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  detectFormat,
  findMvhdDuration,
  ingestImage,
  INGEST_PIXEL_CAP,
  readMovieDurationSeconds,
  sourceMediaIngestOf,
  stripJpegMetadata,
  stripPngMetadata,
  stripWebpMetadata,
  webpIsLossless,
} from "./index";

const W = 40;
const H = 20;

/** Red left half, blue right half, so a rotation is visible. */
function rawFrame(): Buffer {
  const data = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      if (x < W / 2) {
        data[o] = 230;
      } else {
        data[o + 2] = 230;
      }
    }
  }
  return data;
}

function frame(): sharp.Sharp {
  return sharp(rawFrame(), { raw: { width: W, height: H, channels: 3 } });
}

/** EXIF with a camera make and GPS style payload, orientation as given. */
function exifFor(orientation: number) {
  return { orientation, exif: { IFD0: { Make: "SecretCam", Model: "Serial 12345" } } };
}

async function pixels(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes).rotate().raw().toBuffer();
}

describe("detectFormat", () => {
  it("reads the real format from magic bytes", async () => {
    expect(detectFormat(await frame().jpeg().toBuffer())).toBe("jpeg");
    expect(detectFormat(await frame().png().toBuffer())).toBe("png");
    expect(detectFormat(await frame().webp().toBuffer())).toBe("webp");
    expect(detectFormat(await frame().gif().toBuffer())).toBe("gif");
    expect(detectFormat(await frame().tiff().toBuffer())).toBe("tiff");
  });

  it("sorts ISO BMFF files by brand", () => {
    const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`, "latin1"), Buffer.alloc(12)]);
    expect(detectFormat(ftyp("heic"))).toBe("heic");
    expect(detectFormat(ftyp("mif1"))).toBe("heic");
    expect(detectFormat(ftyp("avif"))).toBe("avif");
    expect(detectFormat(ftyp("qt  "))).toBe("quicktime");
    expect(detectFormat(ftyp("isom"))).toBe("mp4");
  });

  it("returns null for anything else", () => {
    expect(detectFormat(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(detectFormat(Buffer.from("%PDF-1.7"))).toBeNull();
    expect(detectFormat(Buffer.alloc(0))).toBeNull();
  });
});

describe("ingestImage", () => {
  it("strips EXIF from an upright JPEG without re-encoding a pixel", async () => {
    const input = await frame().jpeg({ quality: 90 }).withExif(exifFor(1).exif).toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const result = await ingestImage(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.reencoded).toBe(false);
    expect(result.sourceFormat).toBe("jpeg");
    expect(result.format).toBe("jpeg");
    expect([result.width, result.height]).toEqual([W, H]);
    const meta = await sharp(result.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(result.bytes.includes(Buffer.from("SecretCam"))).toBe(false);
    // Lossless: the decoded pixels are byte for byte the upload's.
    expect((await pixels(result.bytes)).equals(await pixels(input))).toBe(true);
  });

  it("applies orientation to the pixels, then drops the tag", async () => {
    const input = await frame().jpeg({ quality: 95 }).withMetadata(exifFor(6)).toBuffer();
    const result = await ingestImage(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reencoded).toBe(true);
    expect(sourceMediaIngestOf(result)).toEqual({ v: 1, reencoded: true, sourceFormat: "jpeg" });
    expect([result.width, result.height]).toEqual([H, W]);
    const meta = await sharp(result.bytes).metadata();
    expect(meta.orientation ?? 1).toBe(1);
    expect(meta.exif).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([H, W]);
    // Orientation 6: the red left half ends up on top.
    const { data } = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(150);
    expect(data[2]).toBeLessThan(80);
  });

  it("keeps the ICC profile", async () => {
    const input = await frame().jpeg().withIccProfile("p3").withExif(exifFor(1).exif).toBuffer();
    const result = await ingestImage(input);
    expect(result.ok && (await sharp(result.bytes).metadata()).icc).toBeTruthy();
  });

  it("drops trailing data after the first end of image (embedded previews)", async () => {
    const main = await frame().jpeg().toBuffer();
    const preview = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#0f0" } }).jpeg().withExif(exifFor(1).exif).toBuffer();
    const result = await ingestImage(Buffer.concat([main, preview]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes.length).toBeLessThanOrEqual(main.length);
    expect(result.bytes.includes(Buffer.from("SecretCam"))).toBe(false);
  });

  it("returns an already clean JPEG unchanged", async () => {
    const input = await frame().jpeg().toBuffer();
    const result = await ingestImage(input);
    expect(result.ok && result.changed).toBe(false);
    expect(result.ok && sourceMediaIngestOf(result)).toEqual({ v: 1, reencoded: false, sourceFormat: "jpeg" });
  });

  it("strips PNG text and EXIF chunks losslessly", async () => {
    const input = await frame().png().withExif(exifFor(1).exif).toBuffer();
    const result = await ingestImage(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe("png");
    expect(result.reencoded).toBe(false);
    expect((await sharp(result.bytes).metadata()).exif).toBeUndefined();
    expect((await pixels(result.bytes)).equals(await pixels(input))).toBe(true);
  });

  it("strips WebP EXIF and clears the VP8X flag", async () => {
    const input = await frame().webp({ lossless: true }).withExif(exifFor(1).exif).toBuffer();
    const result = await ingestImage(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe("webp");
    expect(result.reencoded).toBe(false);
    expect((await sharp(result.bytes).metadata()).exif).toBeUndefined();
    expect(result.bytes.readUInt32LE(4)).toBe(result.bytes.length - 8);
    expect((await pixels(result.bytes)).equals(await pixels(input))).toBe(true);
  });

  it("keeps a rotated lossless WebP lossless, pixel for pixel", async () => {
    const input = await frame().webp({ lossless: true }).withMetadata(exifFor(6)).toBuffer();
    expect((await sharp(input).metadata()).orientation).toBe(6);
    expect(webpIsLossless(input)).toBe(true);
    const result = await ingestImage(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe("webp");
    expect(result.changed).toBe(true);
    expect(result.reencoded).toBe(true);
    expect([result.width, result.height]).toEqual([H, W]);
    expect(webpIsLossless(result.bytes)).toBe(true);
    expect((await pixels(result.bytes)).equals(await pixels(input))).toBe(true);
  });

  it("writes a rotated lossy WebP as lossy", async () => {
    const input = await frame().webp({ quality: 80 }).withMetadata(exifFor(6)).toBuffer();
    expect(webpIsLossless(input)).toBe(false);
    const result = await ingestImage(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe("webp");
    expect(webpIsLossless(result.bytes)).toBe(false);
  });

  it("turns GIF and TIFF into PNG", async () => {
    const inputs = { gif: await frame().gif().toBuffer(), tiff: await frame().tiff().toBuffer() } as const;
    for (const [sourceFormat, input] of Object.entries(inputs)) {
      const result = await ingestImage(input);
      expect(result.ok && result.format).toBe("png");
      expect(result.ok && result.contentType).toBe("image/png");
      expect(result.ok && sourceMediaIngestOf(result)).toEqual({ v: 1, reencoded: true, sourceFormat });
    }
  });

  it("refuses HEIC with its own notice", async () => {
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(40)]);
    const result = await ingestImage(heic);
    expect(result).toMatchObject({ ok: false, reason: "heic" });
    expect(!result.ok && result.message).toMatch(/Export the photo as JPEG or PNG/);
  });

  it("refuses files that are not photos, whatever they claim to be", async () => {
    expect(await ingestImage(Buffer.from("<html><script>alert(1)</script></html>"))).toMatchObject({
      ok: false,
      reason: "unsupported_type",
    });
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(40)]);
    expect(await ingestImage(mp4)).toMatchObject({ ok: false, reason: "unsupported_type" });
  });

  it("refuses a damaged photo as unreadable", async () => {
    const truncated = (await frame().jpeg().toBuffer()).subarray(0, 30);
    expect(await ingestImage(truncated)).toMatchObject({ ok: false, reason: "unreadable" });
  });

  it("refuses more than 80 megapixels from the header alone", async () => {
    // A PNG whose header claims 9000 x 9000 (81 MP). Nothing is decoded, so
    // the test needs no large buffer.
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(9000, 0);
    ihdr.writeUInt32BE(9000, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const chunk = (type: string, data: Buffer) => {
      const head = Buffer.alloc(4);
      head.writeUInt32BE(data.length, 0);
      const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(body), 0);
      return Buffer.concat([head, body, crc]);
    };
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", Buffer.alloc(0)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(9000 * 9000).toBeGreaterThan(INGEST_PIXEL_CAP);
    expect(await ingestImage(png)).toMatchObject({ ok: false, reason: "too_many_pixels" });
  });
});

describe("byte level strippers", () => {
  it("return null for input they cannot parse", () => {
    expect(stripJpegMetadata(Buffer.from("not a jpeg"))).toBeNull();
    expect(stripPngMetadata(Buffer.from("not a png"))).toBeNull();
    expect(stripWebpMetadata(Buffer.from("not a webp"))).toBeNull();
  });
});

function box(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, payload]);
}

function mvhdV0(timescale: number, duration: number): Buffer {
  const payload = Buffer.alloc(100);
  payload.writeUInt32BE(timescale, 12);
  payload.writeUInt32BE(duration, 16);
  return box("mvhd", payload);
}

function mvhdV1(timescale: number, duration: number): Buffer {
  const payload = Buffer.alloc(112);
  payload[0] = 1;
  payload.writeUInt32BE(timescale, 20);
  payload.writeBigUInt64BE(BigInt(duration), 24);
  return box("mvhd", payload);
}

function rangeReader(file: Buffer) {
  const reads: Array<[number, number]> = [];
  return {
    reads,
    read: async (start: number, end: number) => {
      reads.push([start, end]);
      return new Uint8Array(file.subarray(start, end + 1));
    },
  };
}

describe("readMovieDurationSeconds", () => {
  const ftyp = box("ftyp", Buffer.from("isom\0\0\0\0isommp41", "latin1"));

  it("reads a version 0 movie header behind a large mdat, without reading the mdat", async () => {
    const mdat = box("mdat", Buffer.alloc(50_000));
    const file = Buffer.concat([ftyp, mdat, box("moov", Buffer.concat([mvhdV0(600, 600 * 61), box("trak", Buffer.alloc(16))]))]);
    const reader = rangeReader(file);
    expect(await readMovieDurationSeconds(reader.read, file.length)).toBe(61);
    const bytesRead = reader.reads.reduce((sum, [s, e]) => sum + (e - s + 1), 0);
    expect(bytesRead).toBeLessThan(1000);
  });

  it("reads a version 1 movie header with 64 bit times", async () => {
    const file = Buffer.concat([ftyp, box("moov", mvhdV1(1000, 45_500))]);
    expect(await readMovieDurationSeconds(rangeReader(file).read, file.length)).toBe(45.5);
  });

  it("follows a 64 bit extended box size", async () => {
    const mdatPayload = Buffer.alloc(100);
    const mdat = Buffer.alloc(16);
    mdat.writeUInt32BE(1, 0);
    mdat.write("mdat", 4, "latin1");
    mdat.writeBigUInt64BE(BigInt(16 + mdatPayload.length), 8);
    const file = Buffer.concat([ftyp, mdat, mdatPayload, box("moov", mvhdV0(1, 30))]);
    expect(await readMovieDurationSeconds(rangeReader(file).read, file.length)).toBe(30);
  });

  it("returns null without a movie header", async () => {
    const file = Buffer.concat([ftyp, box("mdat", Buffer.alloc(10))]);
    expect(await readMovieDurationSeconds(rangeReader(file).read, file.length)).toBeNull();
    expect(findMvhdDuration(box("trak", Buffer.alloc(8)))).toBeNull();
  });

  it("returns null for a box size that runs past the file", async () => {
    const bad = Buffer.alloc(8);
    bad.writeUInt32BE(9999, 0);
    bad.write("moov", 4, "latin1");
    expect(await readMovieDurationSeconds(rangeReader(bad).read, bad.length)).toBeNull();
  });
});

describe("screenshot refusal", () => {
  it("refuses a tall phone screen PNG and keeps a camera shaped photo", async () => {
    const screen = await sharp({ create: { width: 1320, height: 2868, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const refused = await ingestImage(screen);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? null : refused.reason).toBe("screenshot");

    const photo = await sharp({ create: { width: 3024, height: 4032, channels: 3, background: "#3366cc" } }).png().toBuffer();
    expect((await ingestImage(photo)).ok).toBe(true);
    const jpegTall = await sharp({ create: { width: 1080, height: 2400, channels: 3, background: "#3366cc" } }).jpeg().toBuffer();
    expect((await ingestImage(jpegTall)).ok).toBe(true);
  });

  it("keeps a 2:1 product export and still refuses a 19.5:9 phone screen", async () => {
    const twoToOne = await sharp({ create: { width: 1000, height: 2000, channels: 3, background: "#3366cc" } }).png().toBuffer();
    expect((await ingestImage(twoToOne)).ok).toBe(true);
    const justUnder = await sharp({ create: { width: 1000, height: 2090, channels: 3, background: "#3366cc" } }).png().toBuffer();
    expect((await ingestImage(justUnder)).ok).toBe(true);

    // 1080 x 2340 is 19.5:9 (2.17), the common Android screen.
    const phone = await sharp({ create: { width: 1080, height: 2340, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const refused = await ingestImage(phone);
    expect(refused.ok ? null : refused.reason).toBe("screenshot");
  });

  it("refuses a capture tagged Screenshot in its metadata whatever its shape", async () => {
    const tagged = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: "#ffffff" } })
      .withExif({ IFD0: { ImageDescription: "Screenshot" } })
      .jpeg()
      .toBuffer();
    const result = await ingestImage(tagged);
    expect(result.ok ? null : result.reason).toBe("screenshot");
  });
});
