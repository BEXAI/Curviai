/**
 * GET /api/jobs/:id/files
 * The delivered files for a job: per channel images, zips and the compliance
 * report, each with a signed download url that expires in 15 minutes
 * (plan 4.2.3 and 3.3.4).
 */

import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { isUuid } from "@/lib/validation/ids";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  // A non uuid id can never match a job; answer 404 before Postgres raises
  // 22P02 (Update.md 4.7).
  if (!isUuid(id)) {
    return NextResponse.json({ error: "This job does not exist in your workspace." }, { status: 404 });
  }
  const services = getServices();
  const workspace = await services.getCurrentWorkspace();
  if (!workspace) {
    return NextResponse.json({ error: "Sign in to see your files." }, { status: 401 });
  }
  const view = await services.listJobFiles(workspace.id, id);
  if (!view) {
    return NextResponse.json({ error: "This job does not exist in your workspace." }, { status: 404 });
  }
  return NextResponse.json(view);
}
