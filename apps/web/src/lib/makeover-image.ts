/**
 * Server side reads for the makeover download: the bytes behind an image url
 * the service produced for the board. Only inline data urls (demo previews)
 * and https urls (signed R2 previews) are read, with a timeout and a size
 * cap; the route never passes a url that came from the request.
 */

/** Largest picture read, in bytes. Uploads and outputs are well under it. */
export const MAKEOVER_MAX_INPUT_BYTES = 40 * 1024 * 1024;
export const MAKEOVER_FETCH_TIMEOUT_MS = 15_000;

/** Bytes of an image url the service produced: an inline data url (demo
 * previews) or an https url (signed R2 previews). Anything else is refused. */
export async function readImageUrl(url: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  if (url.startsWith("data:image/")) {
    const comma = url.indexOf(",");
    if (comma < 0) {
      throw new Error("Malformed data url");
    }
    const meta = url.slice(0, comma);
    const payload = url.slice(comma + 1);
    const bytes = meta.endsWith(";base64")
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    if (bytes.length > MAKEOVER_MAX_INPUT_BYTES) {
      throw new Error("Image too large");
    }
    return bytes;
  }
  if (!url.startsWith("https://")) {
    throw new Error("Unsupported image url");
  }
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(MAKEOVER_FETCH_TIMEOUT_MS), redirect: "error" });
  if (!response.ok) {
    throw new Error(`Image fetch failed with ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAKEOVER_MAX_INPUT_BYTES) {
    throw new Error("Image too large");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAKEOVER_MAX_INPUT_BYTES) {
    throw new Error("Image too large");
  }
  return bytes;
}
