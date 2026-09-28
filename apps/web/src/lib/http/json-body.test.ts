import { describe, expect, it } from "vitest";
import { JOB_BODY_MAX_BYTES, JSON_BODY_MAX_BYTES, readJsonCapped } from "./json-body";

function post(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request("https://curvi.ai/api/x", { method: "POST", body, headers, duplex: "half" } as RequestInit);
}

/** A body with no Content-Length, streamed in chunks. */
function chunked(chunks: number, size: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= chunks) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
  });
}

describe("readJsonCapped", () => {
  it("parses a JSON body under the cap", async () => {
    const result = await readJsonCapped(post(JSON.stringify({ a: 1 })));
    expect(result).toEqual({ ok: true, data: { a: 1 } });
  });

  it("answers 413 when the declared length is over the cap, without reading", async () => {
    const result = await readJsonCapped(post("{}", { "content-length": String(JSON_BODY_MAX_BYTES + 1) }), JSON_BODY_MAX_BYTES);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(413);
      expect(await result.response.json()).toEqual({ error: "This request is too large.", reason: "too_large" });
    }
  });

  it("answers 413 for a streamed body with no length once it passes the cap", async () => {
    const result = await readJsonCapped(post(chunked(100, 1024)), 16_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(413);
    }
  });

  it("answers 400 for a body that is not JSON, and for an empty body", async () => {
    for (const body of ["{ not json", ""]) {
      const result = await readJsonCapped(post(body));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(400);
        expect(await result.response.json()).toMatchObject({ error: "Request body must be JSON." });
      }
    }
  });

  it("gives the job route a larger cap than the default", () => {
    expect(JOB_BODY_MAX_BYTES).toBeGreaterThan(JSON_BODY_MAX_BYTES);
  });
});
