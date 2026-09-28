/**
 * GET /api/jobs/:id/files
 * The delivered files for a job: per channel images, zips and the compliance
 * report (plan 4.2.3 and 3.3.4). Images carry an hour long preview url; every
 * file carries a same origin download link that signs a fresh, named url on
 * each click, so links on an open page never expire (Update.md 6.6).
 */

import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { resolveWorkspace } from "@/lib/services/workspace-response";
import { isUuid } from "@/lib/validation/ids";

export const dynamic = "force-dynamic";

const NOT_FOUND = "This job does not exist in your workspace.";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  }
  const services = getServices();
  const resolved = await resolveWorkspace(services, "Sign in to see your files.");
  if ("response" in resolved) {
    return resolved.response;
  }
  const view = await services.listJobFiles(resolved.workspace.id, id);
  if (!view) {
    return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  }
  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
}
