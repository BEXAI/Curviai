/**
 * GET /api/jobs/[id]
 * Returns the job with per shot status for the progress board. In demo mode
 * every poll advances the simulation one tick. A non uuid id is a 404, never
 * a Postgres error (Update.md 4.7). Signed out is a 401; a workspace that
 * could not be set up is a retryable 503.
 */

import { NextResponse } from "next/server";
import { resolveSignedIn } from "@/lib/http/services";
import { isUuid } from "@/lib/validation/ids";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }
  // A failed workspace setup is a retryable 503, not "Sign in" (Update.md 6.8).
  const resolved = await resolveSignedIn("Sign in to view jobs.");
  if ("response" in resolved) {
    return resolved.response;
  }
  const { services } = resolved;
  const job = await services.getJob(resolved.workspace.id, id);
  if (!job) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }
  return NextResponse.json({ job });
}
