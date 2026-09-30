/**
 * GET /api/v1/openapi.json (PHASE_16 workstream 5)
 * The public API v1 OpenAPI document. Public: it describes the API and
 * holds no workspace data.
 */

import { NextResponse } from "next/server";
import { siteUrl } from "@/lib/env";
import { buildOpenApiDocument } from "@/lib/api-v1/openapi";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(buildOpenApiDocument(siteUrl()), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
