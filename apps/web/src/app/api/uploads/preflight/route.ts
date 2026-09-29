/**
 * POST /api/uploads/preflight
 * Checks an uploaded photo as soon as the upload completes, before any pack
 * or credit hold exists (docs/phases/PHASE_14.md workstream 4 and item
 * 3.2): intake, moderation, the product inventory with the chooser, and the
 * size gate. The answer is cached per upload key, so asking again for the
 * same photo and note costs nothing. The key must sit in this workspace's
 * source prefix and client seats cannot check uploads; the route refuses a
 * cross site Origin and is rate limited by IP and by user like the other
 * upload routes. Demo mode answers a simulated result.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonCapped } from "@/lib/http/json-body";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { resolveSignedIn } from "@/lib/http/services";
import { isWorkspaceSourceKey } from "@/lib/r2";
import { limitByIp, limitByUser, userRateLimitSubject } from "@/lib/rate-limit";
import type { PreflightOutcome } from "@/lib/preflight/types";

export const dynamic = "force-dynamic";
// Intake plus a cutout can take a while on a large photo.
export const maxDuration = 60;

const PreflightRequest = z.object({
  key: z.string().min(1).max(512),
  note: z.string().trim().max(2000).optional(),
});

const REFUSED_STATUS: Record<Extract<PreflightOutcome, { ok: false }>["reason"], number> = {
  forbidden: 403,
  foreign_key: 403,
  invalid_upload: 422,
  unavailable: 503,
};

export async function POST(request: Request): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const ipLimited = await limitByIp(request, "uploads.preflight");
  if (ipLimited) {
    return ipLimited;
  }

  const resolved = await resolveSignedIn("Sign in to upload.");
  if ("response" in resolved) {
    return resolved.response;
  }
  const { services, workspace } = resolved;
  if (workspace.role === "client") {
    return NextResponse.json(
      { error: "Client seats cannot upload product photos.", reason: "forbidden" },
      { status: 403 },
    );
  }

  const userLimited = await limitByUser("uploads.preflight", await userRateLimitSubject(workspace.id));
  if (userLimited) {
    return userLimited;
  }

  const body = await readJsonCapped(request);
  if (!body.ok) {
    return body.response;
  }
  const parsed = PreflightRequest.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request.", issues: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }
  if (!isWorkspaceSourceKey(workspace.id, parsed.data.key)) {
    return NextResponse.json(
      { error: "That upload does not belong to this workspace.", reason: "foreign_key" },
      { status: 403 },
    );
  }

  const outcome = await services.preflightUpload(workspace.id, {
    key: parsed.data.key,
    ...(parsed.data.note ? { note: parsed.data.note } : {}),
  });
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.message, reason: outcome.reason }, { status: REFUSED_STATUS[outcome.reason] });
  }
  return NextResponse.json({ preflight: outcome.preflight });
}
