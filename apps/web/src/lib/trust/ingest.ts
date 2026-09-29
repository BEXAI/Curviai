/**
 * Server side upload ingest (docs/PENDING.md, "Server side upload ingest").
 * The browser PUTs straight to R2 through a presigned url, and the size and
 * content type it claimed at signing are all the server has seen. Before an
 * upload becomes a source_media row or a brand kit logo, this reads the
 * object back and:
 *
 * - photos: checks the real format by magic bytes, the 25 MB and 80
 *   megapixel caps, then strips EXIF, XMP and IPTC with the orientation
 *   applied (packages/pipeline/src/ingest/image.ts). A changed file is
 *   written back to the same key, and the sha256 and upright size recorded
 *   are the server's own, never the client's;
 * - videos: checks the magic bytes (MP4 or QuickTime), the 200 MB cap and
 *   the 60 second length, reading only the box headers and the movie header
 *   through range requests. Video metadata is not stripped (that needs a
 *   remux), and the client sha256 is kept, since hashing 200 MB would mean
 *   downloading all of it.
 *
 * A refused upload is deleted from storage, best effort. A storage error is
 * reported as retryable and deletes nothing.
 */

import { createHash } from "node:crypto";
import {
  detectFormat,
  ingestImage,
  readMovieDurationSeconds,
  sourceMediaIngestOf,
  type SourceMediaIngest,
} from "@curvi/pipeline/ingest";
import { IMAGE_MAX_BYTES, VIDEO_MAX_BYTES, withinVideoDurationCap, type UploadKind } from "@/lib/upload-validation";
import type { TrustStorage } from "./storage";

export type IngestOutcome =
  | {
      ok: true;
      /** Server computed hash of the stored bytes; null for video. */
      sha256: string | null;
      width: number | null;
      height: number | null;
      bytes: number;
      /** True when the stored object was rewritten without its metadata. */
      rewritten: boolean;
      /** What source_media.ingest records for a photo (PHASE_15): whether
       * this check decoded and wrote it again, and its uploaded format.
       * Null for video. Optional so older doubles still type check. */
      ingest?: SourceMediaIngest | null;
    }
  | { ok: false; retryable: boolean; notice: string };

export const INGEST_NOTICES = {
  missing: "We could not find that upload. Upload the file again.",
  imageTooLarge: "That photo is larger than 25 MB. Export a smaller file and upload it again.",
  videoTooLarge: "That video is larger than 200 MB. Trim it and upload it again.",
  notVideo: "That file is not a video we can use. Upload an MP4 or MOV file.",
  videoUnreadable: "We could not read the length of that video. Export it again as MP4 and upload the new file.",
  videoTooLong: "Videos can be up to 60 seconds long. Trim it and upload it again.",
  unavailable: "We could not check that upload right now. Try again in a minute.",
} as const;

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function refuse(storage: TrustStorage, key: string, notice: string): Promise<IngestOutcome> {
  try {
    const failed = await storage.deleteMany([key]);
    if (failed.length > 0) {
      console.warn(`[ingest] could not delete refused upload ${key}`);
    }
  } catch (err) {
    console.warn(`[ingest] could not delete refused upload ${key}`, err);
  }
  return { ok: false, retryable: false, notice };
}

export async function ingestUpload(storage: TrustStorage, key: string, kind: UploadKind): Promise<IngestOutcome> {
  try {
    const head = await storage.head(key);
    if (!head) {
      return { ok: false, retryable: false, notice: INGEST_NOTICES.missing };
    }
    if (kind === "image") {
      if (head.bytes > IMAGE_MAX_BYTES) {
        return refuse(storage, key, INGEST_NOTICES.imageTooLarge);
      }
      const original = await storage.get(key);
      const result = await ingestImage(original);
      if (!result.ok) {
        return refuse(storage, key, result.message);
      }
      if (result.changed) {
        await storage.put(key, result.bytes, result.contentType);
      }
      return {
        ok: true,
        sha256: sha256Hex(result.bytes),
        width: result.width,
        height: result.height,
        bytes: result.bytes.length,
        rewritten: result.changed,
        ingest: sourceMediaIngestOf(result),
      };
    }

    if (head.bytes > VIDEO_MAX_BYTES) {
      return refuse(storage, key, INGEST_NOTICES.videoTooLarge);
    }
    const lead = await storage.getRange(key, 0, Math.min(63, head.bytes - 1));
    const format = detectFormat(lead);
    if (format !== "mp4" && format !== "quicktime") {
      return refuse(storage, key, INGEST_NOTICES.notVideo);
    }
    const seconds = await readMovieDurationSeconds((start, end) => storage.getRange(key, start, end), head.bytes);
    // A fragmented MP4 can carry a zero movie duration; its real length is
    // not read here, so it is refused as unreadable rather than as too long.
    if (seconds === null || seconds <= 0) {
      return refuse(storage, key, INGEST_NOTICES.videoUnreadable);
    }
    if (!withinVideoDurationCap(seconds)) {
      return refuse(storage, key, INGEST_NOTICES.videoTooLong);
    }
    return { ok: true, sha256: null, width: null, height: null, bytes: head.bytes, rewritten: false, ingest: null };
  } catch (err) {
    console.error(`[ingest] could not check upload ${key}`, err);
    return { ok: false, retryable: true, notice: INGEST_NOTICES.unavailable };
  }
}
