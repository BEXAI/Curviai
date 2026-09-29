/**
 * POST /api/v1/checks/main-image (PHASE_16 workstream 5)
 * The free Amazon main image checker on the server: resolution, pure white
 * edges and product fill, measured against the amazon.main registry spec.
 * Needs the checks scope. Uses no credits and stores nothing.
 */

import type { NextResponse } from "next/server";
import { checkMainImage } from "@/lib/api-v1/actions";
import { API_PHOTO_BODY_MAX_BYTES, apiResponse, authorize } from "@/lib/api-v1/http";
import { readJsonCapped } from "@/lib/http/json-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await authorize(request, "checks");
  if ("response" in auth) {
    return auth.response;
  }
  const body = await readJsonCapped(request, API_PHOTO_BODY_MAX_BYTES);
  if (!body.ok) {
    return body.response;
  }
  return apiResponse(await checkMainImage({ caller: auth.caller, headers: request.headers }, body.data));
}
