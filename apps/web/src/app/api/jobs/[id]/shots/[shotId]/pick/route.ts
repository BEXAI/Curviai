/**
 * PUT /api/jobs/[id]/shots/[shotId]/pick   body { picked: boolean }
 * Picks or unpicks one version of a lifestyle scene on a delivered pack
 * (docs/phases/PHASE_16.md workstream 6): a picked version's files ship, an
 * unpicked one's do not. Never charges; every version was charged when it
 * was made. Owners, admins and editors; a job outside the caller's
 * workspace is a 404. Rate limited by IP and by user (assets.write).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonCapped } from "@/lib/http/json-body";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { resolveSignedIn } from "@/lib/http/services";
import { limitByIp, limitByUser, userRateLimitSubject } from "@/lib/rate-limit";
import { isShotId } from "@/lib/services/shot-op-response";
import type { VersionPickResult } from "@/lib/services/types";
import { refusalInit } from "@/lib/services/workspace-response";
import { isUuid } from "@/lib/validation/ids";

export const dynamic = "force-dynamic";

const Body = z.object({ picked: z.boolean() }).strict();

const STATUS: Record<Extract<VersionPickResult, { outcome: "rejected" }>["reason"], number> = {
  not_found: 404,
  role_forbidden: 403,
  not_ready: 409,
  not_a_version: 409,
  channel_full: 409,
  unavailable: 503,
  demo: 400,
};

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string; shotId: string }> },
): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const ipLimited = await limitByIp(request, "assets.write");
  if (ipLimited) {
    return ipLimited;
  }
  const { id, shotId } = await context.params;
  if (!isUuid(id) || !isShotId(shotId)) {
    return NextResponse.json({ error: "Shot not found." }, { status: 404 });
  }
  const resolved = await resolveSignedIn("Sign in to pick versions.");
  if ("response" in resolved) {
    return resolved.response;
  }
  const userLimited = await limitByUser("assets.write", await userRateLimitSubject(resolved.workspace.id));
  if (userLimited) {
    return userLimited;
  }
  const raw = await readJsonCapped(request);
  if (!raw.ok) {
    return raw.response;
  }
  const body = Body.safeParse(raw.data);
  if (!body.success) {
    return NextResponse.json({ error: "Send picked as true or false." }, { status: 400 });
  }
  const result = await resolved.services.pickShotVersion(resolved.workspace.id, id, shotId, body.data.picked);
  if (result.outcome === "saved") {
    return NextResponse.json({ job: result.job });
  }
  return NextResponse.json({ error: result.message, reason: result.reason }, refusalInit(STATUS[result.reason]));
}
