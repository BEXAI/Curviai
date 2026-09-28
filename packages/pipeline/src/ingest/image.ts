/**
 * Server side ingest for uploaded photos (plan 4.4 and 4.5, docs/PENDING.md
 * "Server side upload ingest"). The browser uploads straight to R2 with a
 * presigned PUT, so nothing about the bytes can be trusted until the server
 * reads them back. This module is the pure part of that check:
 *
 * 1. The real format comes from the magic bytes, never from the claimed
 *    content type. JPEG, PNG, WebP, GIF and TIFF are accepted. HEIC and HEIF
 *    are recognized and refused with a plain notice, because the prebuilt
 *    sharp binary decodes AVIF but not HEVC coded HEIC (sharp install docs,
 *    docs/verification.md 2026-09-28). Anything else is refused.
 * 2. Width times height is read from the header only and capped at 80
 *    megapixels before any decode. Every sharp call below also carries
 *    limitInputPixels at the cap, so a crafted header cannot slip a larger
 *    decode past the check.
 * 3. Metadata is stripped: EXIF (camera serials, GPS), XMP, IPTC and
 *    comments. The EXIF orientation is applied to the pixels first, so the
 *    photo still shows upright once the tag is gone. An upright JPEG, PNG or
 *    WebP loses its metadata without a re-encode (segments or chunks are
 *    dropped byte for byte), so the product pixels stay exactly as uploaded.
 *    Only a rotated photo is re-encoded (JPEG at quality 95 with 4:4:4
 *    chroma, as normalizeOrientation does). GIF and TIFF always become a
 *    lossless PNG. The ICC profile is kept in every path.
 */

import sharp from "sharp";

export type IngestImageFormat = "jpeg" | "png" | "webp" | "gif" | "tiff";
export type DetectedFormat = IngestImageFormat | "heic" | "avif" | "mp4" | "quicktime";

/** Uploads above 80 megapixels are refused before any pipeline work. */
export const INGEST_PIXEL_CAP = 80_000_000;

export const INGEST_CONTENT_TYPES: Record<IngestImageFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  tiff: "image/tiff",
};

function ascii(buffer: Uint8Array, offset: number, text: string): boolean {
  if (buffer.length < offset + text.length) {
    return false;
  }
  for (let i = 0; i < text.length; i++) {
    if (buffer[offset + i] !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

function bytesAt(buffer: Uint8Array, offset: number, expected: number[]): boolean {
  return buffer.length >= offset + expected.length && expected.every((value, i) => buffer[offset + i] === value);
}

const HEIC_BRANDS = ["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"];
const AVIF_BRANDS = ["avif", "avis"];
const QUICKTIME_TOP_LEVEL_ATOMS = ["moov", "mdat", "free", "wide", "skip", "pnot"];

/**
 * The file's real format from its leading bytes (the first 64 bytes are
 * enough), or null when it is none of the formats Curvi knows. An ISO BMFF
 * file (ftyp box) is sorted by its major brand: HEIC and AVIF brands are
 * images, "qt  " is QuickTime and every other brand is MP4.
 */
export function detectFormat(head: Uint8Array): DetectedFormat | null {
  if (bytesAt(head, 0, [0xff, 0xd8, 0xff])) {
    return "jpeg";
  }
  if (bytesAt(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "png";
  }
  if (ascii(head, 0, "RIFF") && ascii(head, 8, "WEBP")) {
    return "webp";
  }
  if (ascii(head, 0, "GIF87a") || ascii(head, 0, "GIF89a")) {
    return "gif";
  }
  if (bytesAt(head, 0, [0x49, 0x49, 0x2a, 0x00]) || bytesAt(head, 0, [0x4d, 0x4d, 0x00, 0x2a])) {
    return "tiff";
  }
  if (ascii(head, 4, "ftyp")) {
    const brand = String.fromCharCode(...head.slice(8, 12));
    if (HEIC_BRANDS.includes(brand)) {
      return "heic";
    }
    if (AVIF_BRANDS.includes(brand)) {
      return "avif";
    }
    return brand === "qt  " ? "quicktime" : "mp4";
  }
  if (QUICKTIME_TOP_LEVEL_ATOMS.some((atom) => ascii(head, 4, atom))) {
    return "quicktime";
  }
  return null;
}

export type ImageIngestRefusal = "unsupported_type" | "heic" | "too_many_pixels" | "unreadable";

export type ImageIngestResult =
  | {
      ok: true;
      /** The bytes to store: the upload itself when nothing had to change. */
      bytes: Buffer;
      changed: boolean;
      format: IngestImageFormat;
      contentType: string;
      /** Upright dimensions, after the orientation is applied. */
      width: number;
      height: number;
    }
  | { ok: false; reason: ImageIngestRefusal; message: string };

/** Plain spoken notices for each refusal, shown to the seller as is. */
export const IMAGE_INGEST_MESSAGES: Record<ImageIngestRefusal, string> = {
  unsupported_type: "That file is not a photo we can use. Upload a JPEG, PNG or WebP image.",
  heic: "HEIC photos are not supported yet. Export the photo as JPEG or PNG and upload it again.",
  too_many_pixels: "That photo is larger than 80 megapixels. Resize it and upload it again.",
  unreadable: "We could not read that photo. It may be damaged. Export it again and upload the new file.",
};

function refuse(reason: ImageIngestRefusal): ImageIngestResult {
  return { ok: false, reason, message: IMAGE_INGEST_MESSAGES[reason] };
}

const SHARP_OPTIONS = { limitInputPixels: INGEST_PIXEL_CAP } as const;

/**
 * Checks and cleans one uploaded photo. Never throws for bad input: every
 * failure is a typed refusal with a notice the seller can act on.
 */
export async function ingestImage(input: Buffer): Promise<ImageIngestResult> {
  const detected = detectFormat(input.subarray(0, 64));
  if (detected === "heic" || detected === "avif") {
    return refuse("heic");
  }
  if (!detected || detected === "mp4" || detected === "quicktime") {
    return refuse("unsupported_type");
  }
  let meta: sharp.Metadata;
  try {
    // metadata() reads the header only; nothing is decoded yet. The pixel
    // limit is lifted for this read alone (sharp refuses the header of an
    // oversized image outright), so the cap below can name the real reason.
    meta = await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    return refuse("unreadable");
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) {
    return refuse("unreadable");
  }
  if (width * height > INGEST_PIXEL_CAP) {
    return refuse("too_many_pixels");
  }
  const orientation = meta.orientation ?? 1;
  // Orientations 5 to 8 swap the axes.
  const upright = orientation >= 5 ? { width: height, height: width } : { width, height };

  try {
    if (orientation === 1 && (detected === "jpeg" || detected === "png" || detected === "webp")) {
      const stripped =
        detected === "jpeg" ? stripJpegMetadata(input) : detected === "png" ? stripPngMetadata(input) : stripWebpMetadata(input);
      if (stripped) {
        // The stripped file must still decode to the same frame.
        const check = await sharp(stripped, SHARP_OPTIONS).metadata();
        if (check.width === width && check.height === height) {
          return {
            ok: true,
            bytes: stripped,
            changed: !stripped.equals(input),
            format: detected,
            contentType: INGEST_CONTENT_TYPES[detected],
            ...upright,
          };
        }
      }
      // A container the byte level strip could not parse falls through to a
      // re-encode, which drops metadata too.
    }
    const pipeline = sharp(input, SHARP_OPTIONS).rotate().keepIccProfile();
    let output: { data: Buffer; info: sharp.OutputInfo };
    let format: IngestImageFormat;
    if (detected === "jpeg") {
      format = "jpeg";
      output = await pipeline.jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer({ resolveWithObject: true });
    } else if (detected === "webp") {
      format = "webp";
      output = await pipeline.webp({ quality: 95 }).toBuffer({ resolveWithObject: true });
    } else {
      // PNG stays PNG; GIF and TIFF become PNG, losslessly.
      format = "png";
      output = await pipeline.png().toBuffer({ resolveWithObject: true });
    }
    return {
      ok: true,
      bytes: output.data,
      changed: true,
      format,
      contentType: INGEST_CONTENT_TYPES[format],
      width: output.info.width,
      height: output.info.height,
    };
  } catch {
    return refuse("unreadable");
  }
}

/**
 * Drops the metadata segments of a JPEG without touching the coded image:
 * APP1 (EXIF and XMP), APP3 to APP13 (IPTC, Photoshop, Ducky and the rest),
 * APP15 and comments, APP2 segments other than ICC_PROFILE (the MPF index of
 * embedded previews) and anything after the first end of image marker (the
 * previews themselves). Kept: APP0 (JFIF), APP2 ICC_PROFILE, APP14 (Adobe
 * color transform) and every coding segment. Null when the stream does not
 * parse, so the caller re-encodes instead.
 */
export function stripJpegMetadata(input: Buffer): Buffer | null {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) {
    return null;
  }
  const parts: Buffer[] = [input.subarray(0, 2)];
  let pos = 2;
  while (pos < input.length) {
    if (input[pos] !== 0xff) {
      return null;
    }
    // Fill bytes: any number of 0xff before the marker code.
    while (pos < input.length && input[pos] === 0xff) {
      pos += 1;
    }
    if (pos >= input.length) {
      return null;
    }
    const marker = input[pos];
    pos += 1;
    if (marker === 0xd9) {
      parts.push(Buffer.from([0xff, 0xd9]));
      return Buffer.concat(parts);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(Buffer.from([0xff, marker]));
      continue;
    }
    if (pos + 2 > input.length) {
      return null;
    }
    const length = input.readUInt16BE(pos);
    if (length < 2 || pos + length > input.length) {
      return null;
    }
    const segmentEnd = pos + length;
    const payload = input.subarray(pos + 2, segmentEnd);
    const drop =
      marker === 0xfe ||
      marker === 0xe1 ||
      (marker >= 0xe3 && marker <= 0xed) ||
      marker === 0xef ||
      (marker === 0xe2 && !payload.subarray(0, 12).equals(Buffer.from("ICC_PROFILE\0", "latin1")));
    if (!drop) {
      parts.push(Buffer.concat([Buffer.from([0xff, marker]), input.subarray(pos, segmentEnd)]));
    }
    pos = segmentEnd;
    if (marker === 0xda) {
      // Entropy coded data runs until the next marker that is not a stuffed
      // zero or a restart marker.
      let scanEnd = pos;
      while (scanEnd + 1 < input.length) {
        if (input[scanEnd] === 0xff) {
          const next = input[scanEnd + 1];
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) {
            break;
          }
        }
        scanEnd += 1;
      }
      if (scanEnd + 1 >= input.length) {
        return null;
      }
      parts.push(input.subarray(pos, scanEnd));
      pos = scanEnd;
    }
  }
  return null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROPPED_CHUNKS = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

/**
 * Drops the text, time and EXIF chunks of a PNG (the chunk CRC covers only
 * its own type and data, so the rest stay valid) and anything after IEND.
 * Null when the chunk list does not parse.
 */
export function stripPngMetadata(input: Buffer): Buffer | null {
  if (input.length < 8 || !input.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null;
  }
  const parts: Buffer[] = [PNG_SIGNATURE];
  let pos = 8;
  while (pos + 12 <= input.length) {
    const length = input.readUInt32BE(pos);
    const end = pos + 12 + length;
    if (end > input.length) {
      return null;
    }
    const type = input.toString("latin1", pos + 4, pos + 8);
    if (!PNG_DROPPED_CHUNKS.has(type)) {
      parts.push(input.subarray(pos, end));
    }
    pos = end;
    if (type === "IEND") {
      return Buffer.concat(parts);
    }
  }
  return null;
}

/** VP8X flag bits (WebP container spec): E is EXIF, X is XMP. */
const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;

/**
 * Drops the EXIF and XMP chunks of a WebP, clears their VP8X flags and
 * rewrites the RIFF size. Odd chunks carry one padding byte. Null when the
 * container does not parse.
 */
export function stripWebpMetadata(input: Buffer): Buffer | null {
  if (input.length < 12 || !ascii(input, 0, "RIFF") || !ascii(input, 8, "WEBP")) {
    return null;
  }
  const parts: Buffer[] = [];
  let pos = 12;
  while (pos + 8 <= input.length) {
    const fourcc = input.toString("latin1", pos, pos + 4);
    const size = input.readUInt32LE(pos + 4);
    const end = pos + 8 + size + (size % 2);
    if (pos + 8 + size > input.length) {
      return null;
    }
    const chunk = input.subarray(pos, Math.min(end, input.length));
    if (fourcc === "VP8X") {
      const copy = Buffer.from(chunk);
      copy[8] &= ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG) & 0xff;
      parts.push(copy);
    } else if (fourcc !== "EXIF" && fourcc !== "XMP ") {
      parts.push(chunk);
    }
    pos = end;
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WEBP", 8, "latin1");
  return Buffer.concat([header, body]);
}
