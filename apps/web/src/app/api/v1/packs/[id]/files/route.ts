/**
 * GET /api/v1/packs/{id}/files (PHASE_16 workstream 5)
 * The pack's delivered files, picked versions only, each with a download
 * link signed for 15 minutes. Needs the packs:read scope; ask again for
 * fresh links once they expire.
 */

import type { NextResponse } from "next/server";
import { listPackFiles } from "@/lib/api-v1/actions";
import { apiResponse, authorize } from "@/lib/api-v1/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await context.params;
  const auth = await authorize(request, "packs:read");
  if ("response" in auth) {
    return auth.response;
  }
  return apiResponse(await listPackFiles({ caller: auth.caller, headers: request.headers }, id));
}
