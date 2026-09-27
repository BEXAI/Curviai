import { describe, expect, it } from "vitest";
import {
  IMAGE_MAX_BYTES,
  VIDEO_MAX_BYTES,
  VIDEO_MAX_SECONDS,
  magicByteCheck,
  validateUploadRequest,
  withinPixelCap,
  withinVideoDurationCap,
} from "./upload-validation";

function bytes(...values: Array<number | string>): Uint8Array {
  const out: number[] = [];
  for (const value of values) {
    if (typeof value === "number") {
      out.push(value);
    } else {
      for (const ch of value) {
        out.push(ch.charCodeAt(0));
      }
    }
  }
  return Uint8Array.from(out);
}

// Real magic byte fixtures, built in the test.
const FIXTURES: Record<string, Uint8Array> = {
  "image/jpeg": bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, "JFIF"),
  "image/png": bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, "IHDR"),
  "image/webp": bytes("RIFF", 0x24, 0x00, 0x00, 0x00, "WEBPVP8 "),
  "image/gif": bytes("GIF89a", 0x01, 0x00, 0x01, 0x00),
  "image/tiff": bytes(0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00),
  "video/mp4": bytes(0x00, 0x00, 0x00, 0x18, "ftyp", "isom", 0x00, 0x00, 0x02, 0x00),
  "video/quicktime": bytes(0x00, 0x00, 0x00, 0x14, "ftyp", "qt  ", 0x00, 0x00, 0x00, 0x00),
};

describe("magicByteCheck", () => {
  it("accepts each format's real signature", () => {
    for (const [type, buffer] of Object.entries(FIXTURES)) {
      expect(magicByteCheck(buffer, type), type).toBe(true);
    }
  });

  it("accepts big endian tiff too", () => {
    expect(magicByteCheck(bytes(0x4d, 0x4d, 0x00, 0x2a), "image/tiff")).toBe(true);
  });

  it("accepts legacy quicktime files that start with a moov atom", () => {
    expect(magicByteCheck(bytes(0x00, 0x00, 0x10, 0x00, "moov"), "video/quicktime")).toBe(true);
  });

  it("rejects a buffer whose bytes do not match the claimed type", () => {
    expect(magicByteCheck(FIXTURES["image/png"], "image/jpeg")).toBe(false);
    expect(magicByteCheck(FIXTURES["image/jpeg"], "image/png")).toBe(false);
    expect(magicByteCheck(FIXTURES["video/mp4"], "video/quicktime")).toBe(false);
    expect(magicByteCheck(FIXTURES["image/gif"], "image/webp")).toBe(false);
  });

  it("rejects truncated buffers and unknown types", () => {
    expect(magicByteCheck(bytes(0xff, 0xd8), "image/jpeg")).toBe(false);
    expect(magicByteCheck(new Uint8Array(0), "image/png")).toBe(false);
    expect(magicByteCheck(FIXTURES["image/jpeg"], "application/pdf")).toBe(false);
  });
});

describe("validateUploadRequest", () => {
  it("accepts an allowed image under the 25 MB cap", () => {
    expect(validateUploadRequest({ kind: "image", contentType: "image/jpeg", bytes: IMAGE_MAX_BYTES })).toEqual({
      ok: true,
    });
  });

  it("rejects an image one byte over 25 MB", () => {
    const result = validateUploadRequest({ kind: "image", contentType: "image/jpeg", bytes: IMAGE_MAX_BYTES + 1 });
    expect(result.ok).toBe(false);
  });

  it("accepts a video under the 200 MB cap and rejects one over it", () => {
    expect(validateUploadRequest({ kind: "video", contentType: "video/mp4", bytes: VIDEO_MAX_BYTES })).toEqual({
      ok: true,
    });
    expect(
      validateUploadRequest({ kind: "video", contentType: "video/mp4", bytes: VIDEO_MAX_BYTES + 1 }).ok,
    ).toBe(false);
  });

  it("rejects disallowed content types per kind", () => {
    expect(validateUploadRequest({ kind: "image", contentType: "image/bmp", bytes: 100 }).ok).toBe(false);
    expect(validateUploadRequest({ kind: "image", contentType: "video/mp4", bytes: 100 }).ok).toBe(false);
    expect(validateUploadRequest({ kind: "video", contentType: "video/webm", bytes: 100 }).ok).toBe(false);
  });

  it("rejects non positive sizes", () => {
    expect(validateUploadRequest({ kind: "image", contentType: "image/png", bytes: 0 }).ok).toBe(false);
    expect(validateUploadRequest({ kind: "image", contentType: "image/png", bytes: -5 }).ok).toBe(false);
  });
});

describe("pixel and duration caps", () => {
  it("enforces the 80 megapixel cap", () => {
    expect(withinPixelCap(8000, 10000)).toBe(true);
    expect(withinPixelCap(8001, 10000)).toBe(false);
    expect(withinPixelCap(0, 100)).toBe(false);
  });

  it("enforces the 60 second video cap", () => {
    expect(withinVideoDurationCap(VIDEO_MAX_SECONDS)).toBe(true);
    expect(withinVideoDurationCap(VIDEO_MAX_SECONDS + 0.5)).toBe(false);
    expect(withinVideoDurationCap(0)).toBe(false);
    expect(withinVideoDurationCap(Number.NaN)).toBe(false);
  });
});
