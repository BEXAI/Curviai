/**
 * /api/jobs/[id]/feedback (docs/phases/PHASE_18.md P18-05)
 * GET: whether the feedback card shows for this pack and the signed in
 * person: { feedback: { jobId, eligible, answered } }.
 * POST { usable, wouldPay?, comment?, quoteConsent?, displayName? }: saves
 * the person's one answer for a finished pack (201), or says it was already
 * given (200 with answered true). Any member of the workspace may answer.
 *
 * Writes refuse a cross site Origin, resolve the caller before reading the
 * (capped) body, and are rate limited by IP and by user.
 */

import { NextResponse } from "next/server";
import { FEEDBACK_COPY } from "@/lib/feedback/copy";
import { feedbackUserId, getFeedbackStore, validateFeedbackAnswer } from "@/lib/feedback";
import { readJsonCapped } from "@/lib/http/json-body";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { resolveSignedIn, type SignedInResolution } from "@/lib/http/services";
import { limitByIp, limitByUser, userRateLimitSubject } from "@/lib/rate-limit";
import { isUuid } from "@/lib/validation/ids";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function resolve(id: string): Promise<SignedInResolution> {
  if (!isUuid(id)) {
    return { response: NextResponse.json({ error: FEEDBACK_COPY.notFound }, { status: 404 }) };
  }
  return resolveSignedIn(FEEDBACK_COPY.signIn);
}

async function actorFor(workspaceId: string): Promise<{ workspaceId: string; userId: string } | null> {
  const userId = await feedbackUserId();
  return userId ? { workspaceId, userId } : null;
}

export async function GET(_request: Request, context: Context): Promise<NextResponse> {
  const { id } = await context.params;
  const resolved = await resolve(id);
  if ("response" in resolved) {
    return resolved.response;
  }
  const actor = await actorFor(resolved.workspace.id);
  if (!actor) {
    return NextResponse.json({ error: FEEDBACK_COPY.signIn }, { status: 401 });
  }
  const status = await getFeedbackStore().status(actor, id);
  if (!status) {
    return NextResponse.json({ error: FEEDBACK_COPY.notFound }, { status: 404 });
  }
  return NextResponse.json({ feedback: status });
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const ipLimited = await limitByIp(request, "feedback.write");
  if (ipLimited) {
    return ipLimited;
  }
  const { id } = await context.params;
  const resolved = await resolve(id);
  if ("response" in resolved) {
    return resolved.response;
  }
  const userLimited = await limitByUser("feedback.write", await userRateLimitSubject(resolved.workspace.id));
  if (userLimited) {
    return userLimited;
  }
  const actor = await actorFor(resolved.workspace.id);
  if (!actor) {
    return NextResponse.json({ error: FEEDBACK_COPY.signIn }, { status: 401 });
  }
  const body = await readJsonCapped(request);
  if (!body.ok) {
    return body.response;
  }
  const checked = validateFeedbackAnswer(body.data);
  if (!checked.ok) {
    return NextResponse.json({ error: checked.message, reason: "invalid" }, { status: 400 });
  }
  const result = await getFeedbackStore().submit(actor, id, checked.answer, "pack_page");
  switch (result.outcome) {
    case "saved":
      return NextResponse.json({ feedback: result.status }, { status: 201 });
    case "already":
      return NextResponse.json({ feedback: result.status, notice: FEEDBACK_COPY.already });
    case "rejected":
      return NextResponse.json(
        { error: result.message, reason: result.reason },
        { status: result.reason === "not_found" ? 404 : 409 },
      );
  }
}
