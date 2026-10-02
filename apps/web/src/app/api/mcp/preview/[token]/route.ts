/**
 * GET /api/mcp/preview/{token} (PHASE_19 P19-17)
 * A lasting preview link an assistant shared from get_pack: after every
 * check in lib/mcp-links, the delivered image re-encoded as a JPEG no larger
 * than 1,024 pixels on its longest side, upright, flattened on white and
 * with no metadata at all (shareImageJpeg), so nothing stored in the file
 * goes out with it. Images only; the query string is never read.
 */

import { shareImageJpeg } from "@curvi/pipeline/share-image";
import { getMcpLinkBackend } from "@/lib/mcp-links-backend";
import { MCP_PREVIEW_MAX_SIDE, checkMcpLink, linkGone } from "@/lib/mcp-links";
import { getObjectBytes } from "@/lib/r2";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Browsers may reuse a preview for five minutes; shared caches may not. */
const CACHE_CONTROL = "private, max-age=300";

/**
 * Rendered previews by storage key. A stored file never changes under its
 * key, so a hit is current; the link checks above run on every request, so
 * a revoked connection gets nothing from the cache. Bounded by entries and
 * bytes.
 */
const CACHE_MAX_ENTRIES = 64;
const CACHE_MAX_BYTES = 24 * 1024 * 1024;
const globalScope = globalThis as typeof globalThis & { __curviMcpPreviewCache?: Map<string, Buffer> };

function cache(): Map<string, Buffer> {
  globalScope.__curviMcpPreviewCache ??= new Map();
  return globalScope.__curviMcpPreviewCache;
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

export async function GET(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await context.params;
  const check = await checkMcpLink(request, token, "preview", { backend: getMcpLinkBackend });
  if (!check.ok) {
    return check.response;
  }
  const key = check.file.key;
  let jpeg = cache().get(key);
  if (!jpeg) {
    const bytes = await getObjectBytes(key);
    if (!bytes) {
      return linkGone(404);
    }
    try {
      jpeg = await shareImageJpeg(bytes, MCP_PREVIEW_MAX_SIDE);
    } catch {
      return linkGone(404);
    }
  }
  remember(key, jpeg);
  return new Response(new Uint8Array(jpeg), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
