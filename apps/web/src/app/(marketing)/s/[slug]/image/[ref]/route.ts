/**
 * GET /s/[slug]/image/[ref]
 * One image of a published share page, fetched from the private bucket and
 * re-encoded as a bounded JPEG with no metadata, so the seller's original
 * photo never goes out with its EXIF (GPS, camera serial). Only the images
 * the page itself shows are reachable, and only while it is published; a
 * page taken down stops serving within the short cache time.
 */

import { NextResponse } from "next/server";
import { shareImageJpeg } from "@curvi/pipeline/share-image";
import { isR2Configured } from "@/lib/env";
import { getObjectBytes } from "@/lib/r2";
import { limitByIp } from "@/lib/rate-limit";
import { getShareStore } from "@/lib/shares";

export const dynamic = "force-dynamic";

/** Browsers may reuse an image for five minutes; shared caches may not keep it. */
const CACHE_CONTROL = "private, max-age=300";

/**
 * Rendered JPEGs by storage key. Stored objects never change under a key,
 * so a hit is always current; a page taken down stops being served because
 * the key lookup above runs on every request. Bounded by entries and bytes
 * so the cache cannot grow the instance's memory without limit.
 */
const CACHE_MAX_ENTRIES = 64;
const CACHE_MAX_BYTES = 24 * 1024 * 1024;
const globalScope = globalThis as typeof globalThis & { __curviShareImageCache?: Map<string, Buffer> };

function cache(): Map<string, Buffer> {
  globalScope.__curviShareImageCache ??= new Map();
  return globalScope.__curviShareImageCache;
}

function remember(key: string, jpeg: Buffer): void {
  const entries = cache();
  entries.delete(key);
  entries.set(key, jpeg);
  let bytes = 0;
  for (const value of entries.values()) bytes += value.byteLength;
  for (const oldest of entries.keys()) {
    if (entries.size <= CACHE_MAX_ENTRIES && bytes <= CACHE_MAX_BYTES) break;
    bytes -= entries.get(oldest)?.byteLength ?? 0;
    entries.delete(oldest);
  }
}

function notFound(): NextResponse {
  return NextResponse.json({ error: "Image not found." }, { status: 404 });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string; ref: string }> },
): Promise<NextResponse> {
  const limited = await limitByIp(request, "shares.image");
  if (limited) {
    return limited;
  }
  const { slug, ref } = await context.params;
  if (!isR2Configured()) {
    return notFound();
  }
  const key = await getShareStore().imageKey(slug, ref);
  if (!key) {
    return notFound();
  }
  let jpeg = cache().get(key);
  if (jpeg) {
    remember(key, jpeg);
  } else {
    const bytes = await getObjectBytes(key);
    if (!bytes) {
      return notFound();
    }
    try {
      jpeg = await shareImageJpeg(bytes);
    } catch {
      // A file sharp cannot decode (for example a HEIC photo) is left off.
      return notFound();
    }
    remember(key, jpeg);
  }
  return new NextResponse(new Uint8Array(jpeg), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
