/**
 * Reads a request body as text with a byte cap. request.text() buffers the
 * whole body first, so a chunked upload with no Content-Length (or a false
 * one) could stream hundreds of megabytes into memory before any size check
 * ran. This reads the stream, counts bytes and cancels it as soon as the cap
 * is passed. Route handlers have no default body limit of their own.
 */

/** Cap for signed webhook bodies (Stripe, Shopify): real events are a few
 * kilobytes, so 1 MB leaves room without buffering an attacker's stream. */
export const WEBHOOK_MAX_BYTES = 1_000_000;

export type BodyReadResult = { ok: true; text: string } | { ok: false; reason: "too_large" | "unreadable" };

export async function readBodyLimited(request: Request, maxBytes: number): Promise<BodyReadResult> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: "too_large" };
  }
  if (!request.body) {
    return { ok: true, text: "" };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}
