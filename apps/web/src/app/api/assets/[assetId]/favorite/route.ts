/**
 * PUT /api/assets/[assetId]/favorite   body { favorite: boolean }
 * Adds a delivered image to the workspace's favorites, or removes it
 * (docs/phases/PHASE_16.md workstream 6). Owners, admins and editors; an
 * asset outside the caller's workspace is a 404. Rate limited by IP and by
 * user (assets.write).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonCapped } from "@/lib/http/json-body";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { resolveSignedIn } from "@/lib/http/services";
import { limitByIp, limitByUser, userRateLimitSubject } from "@/lib/rate-limit";
import { refusalInit } from "@/lib/services/workspace-response";
import type { FavoriteResult } from "@/lib/services/types";
import { isUuid } from "@/lib/validation/ids";

export const dynamic = "force-dynamic";

const Body = z.object({ favorite: z.boolean() }).strict();

const STATUS: Record<Extract<FavoriteResult, { outcome: "rejected" }>["reason"], number> = {
  not_found: 404,
  role_forbidden: 403,
  unavailable: 503,
  demo: 400,
};

export async function PUT(
  request: Request,
  context: { params: Promise<{ assetId: string }> },
): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const ipLimited = await limitByIp(request, "assets.write");
  if (ipLimited) {
    return ipLimited;
  }
  const { assetId } = await context.params;
  if (!isUuid(assetId)) {
    return NextResponse.json({ error: "This image does not exist in your workspace." }, { status: 404 });
  }
  const resolved = await resolveSignedIn("Sign in to save favorites.");
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
    return NextResponse.json({ error: "Send favorite as true or false." }, { status: 400 });
  }
  const result = await resolved.services.setFavorite(resolved.workspace.id, assetId, body.data.favorite);
  if (result.outcome === "saved") {
    return NextResponse.json({ favorite: result.favorite });
  }
  return NextResponse.json({ error: result.message, reason: result.reason }, refusalInit(STATUS[result.reason]));
}
