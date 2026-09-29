/**
 * POST /api/v1/packs (PHASE_16 workstream 5)
 * Starts a pack from real product photos (links or base64) for the API
 * key's workspace. Needs the packs:write scope and an Idempotency-Key
 * header: a retry with the same key and body replays the pack (200), the
 * same key with another body is a 409. Credits are held, channels checked
 * against the plan and requests rate limited exactly as the web form does
 * (lib/api-v1/actions). The key is checked before the capped body is read.
 */

import type { NextResponse } from "next/server";
import { createPack } from "@/lib/api-v1/actions";
import { API_PHOTO_BODY_MAX_BYTES, apiResponse, authorize } from "@/lib/api-v1/http";
import { readJsonCapped } from "@/lib/http/json-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await authorize(request, "packs:write");
  if ("response" in auth) {
    return auth.response;
  }
  const body = await readJsonCapped(request, API_PHOTO_BODY_MAX_BYTES);
  if (!body.ok) {
    return body.response;
  }
  const result = await createPack(
    { caller: auth.caller, headers: request.headers },
    body.data,
    request.headers.get("idempotency-key"),
  );
  return apiResponse(result);
}
