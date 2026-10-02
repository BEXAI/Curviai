/**
 * The pixel size of a PNG or JPEG, read from its header, so the build can
 * check that the logo and composer icon are square and within 48 to 4,096
 * px (O4) without an image library.
 */

export interface ImageSize {
  format: "png" | "jpeg";
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(bytes: Buffer): ImageSize | null {
  // The signature, then the IHDR chunk: length (4), type (4), width, height.
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("latin1", 12, 16) !== "IHDR") {
    return null;
  }
  return { format: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Start of frame markers that carry the size: baseline, extended,
 * progressive and lossless, Huffman or arithmetic coded. */
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      return null;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      // Fill byte.
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (SOF_MARKERS.has(marker)) {
      if (offset + 9 > bytes.length) {
        return null;
      }
      return { format: "jpeg", height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd9 || marker === 0xda || length < 2) {
      return null;
    }
    offset += 2 + length;
  }
  return null;
}

/** The size of a PNG or JPEG, or null for anything else or a broken header. */
export function imageSize(bytes: Buffer): ImageSize | null {
  return pngSize(bytes) ?? jpegSize(bytes);
}
