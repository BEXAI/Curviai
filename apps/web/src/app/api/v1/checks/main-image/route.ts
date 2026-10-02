/**
 * POST /api/v1/checks/main-image (PHASE_16 workstream 5)
 * The marketplace main image checker: resolution, background and product
 * fill measured against a verified registry spec, with Amazon the default.
 * Needs the checks scope. Uses no credits and stores nothing. An image
 * attached in ChatGPT (image) is an MCP tool field only (PHASE_19 P19-15),
 * so this route refuses the field as it always did.
 */

import type { NextResponse } from "next/server";
import { chatFileRefused, checkMainImage } from "@/lib/api-v1/actions";
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
  const refused = chatFileRefused(body.data, "image");
  if (refused) {
    return apiResponse(refused);
  }
  return apiResponse(await checkMainImage({ caller: auth.caller, headers: request.headers }, body.data));
}
