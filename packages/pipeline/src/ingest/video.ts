/**
 * Source video length check for server side ingest (plan 4.5: source video
 * is capped at 60 seconds). MP4 and QuickTime files are a list of boxes
 * (atoms): a 32 bit size, a 4 character type, then the payload. Size 1 means
 * a 64 bit size follows the type; size 0, allowed only at the top level,
 * means the box runs to the end of the file (Apple QuickTime File Format,
 * "Atoms"). The duration lives in the movie header, moov/mvhd: version (1
 * byte), flags (3), then creation and modification times, the time scale (4)
 * and the duration, with 32 bit times in version 0 and 64 bit times in
 * version 1 (ISO/IEC 14496-12). Duration in seconds is duration / time scale.
 *
 * The reader works on ranges, so a 200 MB upload is never loaded whole: only
 * each top level box header and then the moov box are read. moov holds the
 * sample tables, so it is capped (MAX_MOOV_BYTES) to keep memory bounded.
 */

export type ReadRange = (start: number, endInclusive: number) => Promise<Uint8Array>;

/** A moov box above this size is refused as unreadable. */
export const MAX_MOOV_BYTES = 32 * 1024 * 1024;
/** Top level boxes walked before giving up. */
const MAX_TOP_LEVEL_BOXES = 64;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/** Seconds from an mvhd payload (the bytes after the box header), or null. */
export function mvhdDurationSeconds(payload: Uint8Array): number | null {
  const dv = view(payload);
  const version = payload[0];
  if (version === 0 && payload.length >= 20) {
    const timescale = dv.getUint32(12);
    const duration = dv.getUint32(16);
    return timescale > 0 ? duration / timescale : null;
  }
  if (version === 1 && payload.length >= 32) {
    const timescale = dv.getUint32(20);
    const duration = Number(dv.getBigUint64(24));
    return timescale > 0 ? duration / timescale : null;
  }
  return null;
}

/** Finds mvhd among the direct children of a moov payload. */
export function findMvhdDuration(moovPayload: Uint8Array): number | null {
  const dv = view(moovPayload);
  let pos = 0;
  while (pos + 8 <= moovPayload.length) {
    let size = dv.getUint32(pos);
    const type = fourcc(moovPayload, pos + 4);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > moovPayload.length) {
        return null;
      }
      size = Number(dv.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = moovPayload.length - pos;
    }
    if (size < header || pos + size > moovPayload.length) {
      return null;
    }
    if (type === "mvhd") {
      return mvhdDurationSeconds(moovPayload.subarray(pos + header, pos + size));
    }
    pos += size;
  }
  return null;
}

/**
 * The movie duration in seconds, read through range requests, or null when
 * the file has no readable movie header.
 */
export async function readMovieDurationSeconds(readRange: ReadRange, totalBytes: number): Promise<number | null> {
  let pos = 0;
  for (let boxes = 0; boxes < MAX_TOP_LEVEL_BOXES && pos + 8 <= totalBytes; boxes++) {
    const head = await readRange(pos, Math.min(pos + 15, totalBytes - 1));
    if (head.length < 8) {
      return null;
    }
    const dv = view(head);
    let size = dv.getUint32(0);
    const type = fourcc(head, 4);
    let header = 8;
    if (size === 1) {
      if (head.length < 16) {
        return null;
      }
      size = Number(dv.getBigUint64(8));
      header = 16;
    } else if (size === 0) {
      size = totalBytes - pos;
    }
    if (size < header || pos + size > totalBytes) {
      return null;
    }
    if (type === "moov") {
      if (size > MAX_MOOV_BYTES) {
        return null;
      }
      const payload = await readRange(pos + header, pos + size - 1);
      return findMvhdDuration(payload);
    }
    pos += size;
  }
  return null;
}
