/**
 * GET /api/v1/channels (PHASE_16 workstream 5)
 * Every channel spec a pack can name, with whether the key's plan can use
 * it today, and the pack bundles. Any valid key may read it.
 */

import type { NextResponse } from "next/server";
import { listChannels } from "@/lib/api-v1/actions";
import { apiResponse, authorize } from "@/lib/api-v1/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await authorize(request, null);
  if ("response" in auth) {
    return auth.response;
  }
  return apiResponse(listChannels({ caller: auth.caller }));
}
