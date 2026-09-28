/**
 * POST /api/jobs/[id]/shots/[shotId]/retry
 * Runs one shot that needs review again on a delivered pack. Its credits are
 * held by the pack rules and charged only if its file is delivered; if it
 * needs review again they go back. Owner, admin and editor only; a job
 * outside the caller's workspace is a 404. Rate limited like starting a
 * pack, since it spends credits and provider time.
 */

import { NextResponse } from "next/server";
import { limitByIp, limitByUser, userRateLimitSubject } from "@/lib/rate-limit";
import { getServices } from "@/lib/services";
import { isShotId, shotOpResponse } from "@/lib/services/shot-op-response";
import { resolveWorkspace } from "@/lib/services/workspace-response";
import { isUuid } from "@/lib/validation/ids";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; shotId: string }> },
): Promise<NextResponse> {
  const ipLimited = await limitByIp(request, "jobs.create");
  if (ipLimited) {
    return ipLimited;
  }
  const { id, shotId } = await context.params;
  if (!isUuid(id) || !isShotId(shotId)) {
    return NextResponse.json({ error: "Shot not found." }, { status: 404 });
  }
  const services = getServices();
  const resolved = await resolveWorkspace(services, "Sign in to run a shot again.");
  if ("response" in resolved) {
    return resolved.response;
  }
  const userLimited = await limitByUser("jobs.create", await userRateLimitSubject(resolved.workspace.id));
  if (userLimited) {
    return userLimited;
  }
  return shotOpResponse(await services.retryShot(resolved.workspace.id, id, shotId));
}
