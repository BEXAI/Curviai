/**
 * POST /api/jobs/[id]/cancel
 * Cancels a running pack. Only a member of the job's workspace reaches it
 * (the job is looked up inside the caller's workspace, so any other job is a
 * 404), and client seats are refused with a 403 because they cannot spend or
 * return credits (plan 4.3). The job is marked canceled, the runner stops its
 * remaining shots at the next checkpoint, and every credit held for shots
 * that were not delivered goes back to the balance. A pack that already
 * finished answers 409.
 */

import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { cancelResponse } from "@/lib/services/shot-op-response";
import { resolveWorkspace } from "@/lib/services/workspace-response";
import { isUuid } from "@/lib/validation/ids";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }
  const services = getServices();
  const resolved = await resolveWorkspace(services, "Sign in to cancel a pack.");
  if ("response" in resolved) {
    return resolved.response;
  }
  if (resolved.workspace.role === "client") {
    return NextResponse.json(
      { error: "Client seats can review packs but cannot cancel them.", reason: "role_forbidden" },
      { status: 403 },
    );
  }
  return cancelResponse(await services.cancelJob(resolved.workspace.id, id));
}
