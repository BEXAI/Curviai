/**
 * Writes the plugin ZIP with archiver, files at the archive root, in a fixed
 * order and with a fixed date so the same folder always gives the same
 * archive, and reads its central directory back so the build checks the
 * archive it wrote, not only the folder it started from.
 */

import { createWriteStream } from "node:fs";
import archiver from "archiver";

export interface ZipEntry {
  /** Path inside the archive, forward slashes, no leading slash. */
  path: string;
  data: Buffer;
}

/** Every entry gets this date, so rebuilding gives the same bytes. */
const FIXED_DATE = new Date("2026-10-01T00:00:00.000Z");

export async function writeZip(entries: readonly ZipEntry[], outPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("warning", reject);
    archive.on("error", reject);
    archive.pipe(output);
    for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
      archive.append(entry.data, { name: entry.path, date: FIXED_DATE });
    }
    void archive.finalize();
  });
}

export interface ZipListing {
  /** File names in the central directory, in order. */
  names: string[];
  /** Uncompressed sizes by name. */
  sizes: Map<string, number>;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** The central directory of a ZIP (no ZIP64, which a plugin never needs). */
export function readZipListing(zip: Buffer): ZipListing {
  // The end of central directory record sits in the last 22 + 65,535 bytes.
  const floor = Math.max(0, zip.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = zip.length - 22; offset >= floor; offset -= 1) {
    if (zip.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("The archive has no end of central directory record.");
  }
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const names: string[] = [];
  const sizes = new Map<string, number>();
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error("The archive's central directory is broken.");
    }
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength);
    names.push(name);
    sizes.set(name, size);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { names, sizes };
}
