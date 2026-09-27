/**
 * GET /api/jobs/[id]
 * Returns the job with per shot status for the progress board. In demo mode
 * every poll advances the simulation one tick.
 */

import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const services = getServices();
  const workspace = await services.getCurrentWorkspace();
  if (!workspace) {
    return NextResponse.json({ error: "Sign in to view jobs." }, { status: 401 });
  }
  const job = await services.getJob(workspace.id, id);
  if (!job) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }
  return NextResponse.json({ job });
}
