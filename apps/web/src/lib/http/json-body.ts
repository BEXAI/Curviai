/**
 * Reads a JSON request body with a byte cap. request.json() buffers the
 * whole body before parsing, with no limit, so a route that parsed before
 * any other check let an anonymous caller stream megabytes into memory.
 * This reads through readBodyLimited, answers 413 once the cap is passed and
 * 400 when the body is not JSON.
 */

import { NextResponse } from "next/server";
import { readBodyLimited } from "./read-body";

/** Cap for the small JSON bodies most routes take (a link, a few ids). */
export const JSON_BODY_MAX_BYTES = 16_000;

/** Cap for POST /api/jobs: up to 8 uploads, notes and seller inputs. */
export const JOB_BODY_MAX_BYTES = 64_000;

export const BODY_TOO_LARGE_MESSAGE = "This request is too large.";
export const BODY_NOT_JSON_MESSAGE = "Request body must be JSON.";

export type JsonBodyResult = { ok: true; data: unknown } | { ok: false; response: NextResponse };

export async function readJsonCapped(request: Request, maxBytes: number = JSON_BODY_MAX_BYTES): Promise<JsonBodyResult> {
  const body = await readBodyLimited(request, maxBytes);
  if (!body.ok) {
    if (body.reason === "too_large") {
      return {
        ok: false,
        response: NextResponse.json({ error: BODY_TOO_LARGE_MESSAGE, reason: "too_large" }, { status: 413 }),
      };
    }
    return { ok: false, response: NextResponse.json({ error: BODY_NOT_JSON_MESSAGE, reason: "invalid_json" }, { status: 400 }) };
  }
  try {
    return { ok: true, data: JSON.parse(body.text) as unknown };
  } catch {
    return { ok: false, response: NextResponse.json({ error: BODY_NOT_JSON_MESSAGE, reason: "invalid_json" }, { status: 400 }) };
  }
}
