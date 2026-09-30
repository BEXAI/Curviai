/**
 * GET /api/v1/packs/{id} (PHASE_16 workstream 5)
 * A pack of the API key's workspace with its status and per shot results.
 * Needs the packs:read scope; a pack of another workspace is a 404.
 */

import type { NextResponse } from "next/server";
import { getPack } from "@/lib/api-v1/actions";
import { apiResponse, authorize } from "@/lib/api-v1/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await context.params;
  const auth = await authorize(request, "packs:read");
  if ("response" in auth) {
    return auth.response;
  }
  return apiResponse(await getPack({ caller: auth.caller, headers: request.headers }, id));
}
