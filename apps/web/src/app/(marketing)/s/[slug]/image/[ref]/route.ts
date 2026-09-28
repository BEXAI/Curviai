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
import { getShareStore } from "@/lib/shares";

export const dynamic = "force-dynamic";

/** Browsers may reuse an image for five minutes; shared caches may not keep it. */
const CACHE_CONTROL = "private, max-age=300";

function notFound(): NextResponse {
  return NextResponse.json({ error: "Image not found." }, { status: 404 });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string; ref: string }> },
): Promise<NextResponse> {
  const { slug, ref } = await context.params;
  if (!isR2Configured()) {
    return notFound();
  }
  const key = await getShareStore().imageKey(slug, ref);
  if (!key) {
    return notFound();
  }
  const bytes = await getObjectBytes(key);
  if (!bytes) {
    return notFound();
  }
  let jpeg: Buffer;
  try {
    jpeg = await shareImageJpeg(bytes);
  } catch {
    // A file sharp cannot decode (for example a HEIC photo) is left off.
    return notFound();
  }
  return new NextResponse(new Uint8Array(jpeg), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
