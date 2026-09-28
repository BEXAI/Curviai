import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ImportFetcher } from "./import-product";
import { imageDimensions, importPhoto, sniffImageType } from "./image";
import { ImportFetchError } from "./safe-fetch";

function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function gif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(16);
  buf.write("GIF89a", 0, "latin1");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function jpeg(width: number, height: number): Buffer {
  // SOI, an APP0 segment to skip, then SOF0 with the size.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14)]);
  const sof = Buffer.alloc(19);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(0xc0, 1);
  sof.writeUInt16BE(17, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function webpVp8x(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "latin1");
  buf.write("WEBP", 8, "latin1");
  buf.write("VP8X", 12, "latin1");
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

function webpLossless(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "latin1");
  buf.write("WEBP", 8, "latin1");
  buf.write("VP8L", 12, "latin1");
  buf[20] = 0x2f;
  const w = width - 1;
  const h = height - 1;
  buf[21] = w & 0xff;
  buf[22] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6);
  buf[23] = (h >> 2) & 0xff;
  buf[24] = (h >> 10) & 0x0f;
  return buf;
}

function serve(body: Buffer, status = 200) {
  return vi.fn<ImportFetcher>(async (url) => ({ status, contentType: "text/html", body, url: new URL(url.toString()) }));
}

describe("image headers", () => {
  it("proves the type from magic bytes, not from the name or header", () => {
    expect(sniffImageType(png(1, 1))).toBe("image/png");
    expect(sniffImageType(gif(1, 1))).toBe("image/gif");
    expect(sniffImageType(jpeg(1, 1))).toBe("image/jpeg");
    expect(sniffImageType(webpVp8x(1, 1))).toBe("image/webp");
    expect(sniffImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageType(Buffer.from("<html></html>"))).toBeNull();
  });

  it("reads width and height from each header", () => {
    expect(imageDimensions(png(1600, 900), "image/png")).toEqual({ width: 1600, height: 900 });
    expect(imageDimensions(gif(320, 240), "image/gif")).toEqual({ width: 320, height: 240 });
    expect(imageDimensions(jpeg(2048, 1536), "image/jpeg")).toEqual({ width: 2048, height: 1536 });
    expect(imageDimensions(webpVp8x(4000, 3000), "image/webp")).toEqual({ width: 4000, height: 3000 });
    expect(imageDimensions(webpLossless(1234, 567), "image/webp")).toEqual({ width: 1234, height: 567 });
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg")).toBeNull();
  });
});

describe("importPhoto", () => {
  it("returns the bytes, proven type, sha256 and size", async () => {
    const body = png(1600, 1600);
    const fetcher = serve(body);
    const result = await importPhoto("https://cdn.shopify.com/mug.png", { fetcher });
    expect(result).toEqual({
      ok: true,
      photo: {
        body,
        contentType: "image/png",
        sha256: createHash("sha256").update(body).digest("hex"),
        width: 1600,
        height: 1600,
      },
    });
    expect(fetcher.mock.calls[0]?.[1].maxBytes).toBe(25 * 1024 * 1024);
    expect(fetcher.mock.calls[0]?.[1].accept).not.toContain("avif");
  });

  it("refuses anything that is not an allowed image", async () => {
    const result = await importPhoto("https://cdn.example.com/x", { fetcher: serve(Buffer.from("<html>")) });
    expect(result).toMatchObject({ ok: false, reason: "not_image" });
  });

  it("refuses a photo over 80 megapixels", async () => {
    const result = await importPhoto("https://cdn.example.com/x", { fetcher: serve(png(10_000, 9_000)) });
    expect(result).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("maps fetch refusals to plain messages", async () => {
    for (const reason of ["blocked_host", "too_large", "timeout", "network"] as const) {
      const fetcher = vi.fn<ImportFetcher>(async () => {
        throw new ImportFetchError(reason, "x");
      });
      const result = await importPhoto("https://cdn.example.com/x", { fetcher });
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.reason).toBe(reason === "network" ? "unreachable" : reason);
    }
    expect(await importPhoto("https://cdn.example.com/x", { fetcher: serve(png(1, 1), 404) })).toMatchObject({
      ok: false,
      reason: "unreachable",
    });
  });
});
