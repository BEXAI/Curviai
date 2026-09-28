/**
 * POST /api/jobs/[id]/shots/[shotId]/photo
 * Adds the photo a skipped "needs photo" shot waits for, on a delivered
 * pack: the photo is saved to the pack's product and the shots it unlocks
 * are planned and run, held and charged by the pack rules. The body names
 * an upload already signed and stored through /api/uploads/sign; its key
 * must sit in this workspace's source prefix. Owner, admin and editor only;
 * rate limited like starting a pack.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { isWorkspaceSourceKey } from "@/lib/r2";
import { limitByIp, limitByUser, userRateLimitSubject } from "@/lib/rate-limit";
import { getServices } from "@/lib/services";
import { isShotId, shotOpResponse } from "@/lib/services/shot-op-response";
import { resolveWorkspace } from "@/lib/services/workspace-response";
import { isUuid } from "@/lib/validation/ids";

export const dynamic = "force-dynamic";

const PhotoRequest = z.object({
  key: z.string().min(1).max(512),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

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
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const parsed = PhotoRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request.", issues: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }
  const services = getServices();
  const resolved = await resolveWorkspace(services, "Sign in to add a photo.");
  if ("response" in resolved) {
    return resolved.response;
  }
  const { workspace } = resolved;
  const userLimited = await limitByUser("jobs.create", await userRateLimitSubject(workspace.id));
  if (userLimited) {
    return userLimited;
  }
  if (!isWorkspaceSourceKey(workspace.id, parsed.data.key)) {
    return NextResponse.json({ error: "That upload does not belong to this workspace." }, { status: 403 });
  }
  return shotOpResponse(await services.addShotPhoto(workspace.id, id, shotId, parsed.data));
}
