/**
 * POST /api/feedback/[token] (docs/phases/PHASE_18.md P18-05): the answer
 * from a signed feedback link, the one the day 2 email carries (P18-07).
 * Same body as POST /api/jobs/[id]/feedback. The token names the pack and
 * the person (lib/feedback/link.ts); the person must still be a member of
 * the pack's workspace. An invalid, forged or expired link answers 404 with
 * the same words every time. A cross site Origin is refused, and the route
 * is rate limited by IP and by the person the link names.
 */

import { NextResponse } from "next/server";
import { FEEDBACK_COPY } from "@/lib/feedback/copy";
import { resolveFeedbackLink } from "@/lib/feedback/link-actor";
import { validateFeedbackAnswer } from "@/lib/feedback/types";
import { readJsonCapped } from "@/lib/http/json-body";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { limitByIp, limitByUser } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ token: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const ipLimited = await limitByIp(request, "feedback.write");
  if (ipLimited) {
    return ipLimited;
  }
  const { token } = await context.params;
  const target = await resolveFeedbackLink(token);
  if (!target) {
    return NextResponse.json({ error: FEEDBACK_COPY.linkInvalid, reason: "invalid_link" }, { status: 404 });
  }
  const userLimited = await limitByUser("feedback.write", `user:${target.actor.userId}`);
  if (userLimited) {
    return userLimited;
  }
  const body = await readJsonCapped(request);
  if (!body.ok) {
    return body.response;
  }
  const checked = validateFeedbackAnswer(body.data);
  if (!checked.ok) {
    return NextResponse.json({ error: checked.message, reason: "invalid" }, { status: 400 });
  }
  const result = await target.store.submit(target.actor, target.jobId, checked.answer, "email_link");
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
