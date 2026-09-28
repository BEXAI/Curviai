/**
 * /api/jobs/[id]/share
 * GET: the pack's share page status for the job board.
 * POST { kind, gallery }: publish the pack to /s/{slug}, as a before and
 * after or the whole pack, and optionally opt it into the public gallery.
 * DELETE: take the share page (and its gallery entry) down.
 *
 * Publishing is a consent decision, so only owners and admins may do it
 * (403 otherwise). Writes refuse a cross site Origin, resolve the caller
 * before reading the (capped) body, and are rate limited by IP and by user.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonCapped } from "@/lib/http/json-body";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { resolveSignedIn, type SignedInResolution } from "@/lib/http/services";
import { limitByIp, limitByUser, userRateLimitSubject } from "@/lib/rate-limit";
import { getShareStore, type ShareActionResult, type ShareKind } from "@/lib/shares";
import { isUuid } from "@/lib/validation/ids";

export const dynamic = "force-dynamic";

const PublishRequest = z.object({
  kind: z.enum(["before_after", "pack"] as const satisfies readonly ShareKind[]),
  gallery: z.boolean().default(false),
});

type Context = { params: Promise<{ id: string }> };

const STATUS_FOR_REASON = { forbidden: 403, not_found: 404, not_ready: 409, unavailable: 503 } as const;

function actionResponse(result: ShareActionResult): NextResponse {
  if (result.ok) {
    return NextResponse.json({ share: result.status });
  }
  return NextResponse.json({ error: result.message, reason: result.reason }, { status: STATUS_FOR_REASON[result.reason] });
}

async function workspaceFor(id: string, signedOut: string): Promise<SignedInResolution> {
  if (!isUuid(id)) {
    return { response: NextResponse.json({ error: "Pack not found." }, { status: 404 }) };
  }
  return resolveSignedIn(signedOut);
}

export async function GET(_request: Request, context: Context): Promise<NextResponse> {
  const { id } = await context.params;
  const resolved = await workspaceFor(id, "Sign in to share a pack.");
  if ("response" in resolved) {
    return resolved.response;
  }
  const status = await getShareStore().getStatus(resolved.workspace, id);
  if (!status) {
    return NextResponse.json({ error: "Pack not found." }, { status: 404 });
  }
  return NextResponse.json({ share: status });
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const ipLimited = await limitByIp(request, "shares.write");
  if (ipLimited) {
    return ipLimited;
  }
  const { id } = await context.params;
  const resolved = await workspaceFor(id, "Sign in to share a pack.");
  if ("response" in resolved) {
    return resolved.response;
  }
  const userLimited = await limitByUser("shares.write", await userRateLimitSubject(resolved.workspace.id));
  if (userLimited) {
    return userLimited;
  }
  const body = await readJsonCapped(request);
  if (!body.ok) {
    return body.response;
  }
  const parsed = PublishRequest.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  return actionResponse(await getShareStore().publish(resolved.workspace, id, parsed.data));
}

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const ipLimited = await limitByIp(request, "shares.write");
  if (ipLimited) {
    return ipLimited;
  }
  const { id } = await context.params;
  const resolved = await workspaceFor(id, "Sign in to manage sharing.");
  if ("response" in resolved) {
    return resolved.response;
  }
  const userLimited = await limitByUser("shares.write", await userRateLimitSubject(resolved.workspace.id));
  if (userLimited) {
    return userLimited;
  }
  return actionResponse(await getShareStore().unpublish(resolved.workspace, id));
}
