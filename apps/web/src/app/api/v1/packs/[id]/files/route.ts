/**
 * GET /api/v1/packs/{id}/files (PHASE_16 workstream 5)
 * The pack's delivered files, picked versions only, each with a download
 * link signed for 15 minutes. Needs the packs:read scope; ask again for
 * fresh links once they expire. Links handed out count as a download in the
 * server side funnel (docs/phases/PHASE_18.md P18-02).
 */

import type { NextResponse } from "next/server";
import { listPackFiles } from "@/lib/api-v1/actions";
import { apiResponse, authorize } from "@/lib/api-v1/http";
import { recordFunnel } from "@/lib/funnel";

export const dynamic = "force-dynamic";

function handsOutLinks(body: unknown): boolean {
  const files = (body as { files?: Array<{ url?: unknown }> } | null)?.files;
  return Array.isArray(files) && files.some((file) => typeof file.url === "string");
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await context.params;
  const auth = await authorize(request, "packs:read");
  if ("response" in auth) {
    return auth.response;
  }
  const result = await listPackFiles({ caller: auth.caller, headers: request.headers }, id);
  if (result.status === 200 && handsOutLinks(result.body)) {
    await recordFunnel({
      workspaceId: auth.caller.principal.workspaceId,
      name: "download",
      first: true,
      props: { kind: "api" },
    });
  }
  return apiResponse(result);
}
