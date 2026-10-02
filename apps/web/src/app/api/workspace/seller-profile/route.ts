/**
 * PUT /api/workspace/seller-profile   body { category: string | null, channels: string[] }
 * Saves the first run answers from /welcome (docs/phases/PHASE_18.md
 * P18-20): what the workspace sells (a seeded sellerCategories key) and
 * where (seeded channelChoices values). Both are optional; an answer with
 * neither is accepted and saves nothing worth segmenting on. Owners, admins
 * and editors. Same origin only; rate limited by IP and by user.
 */

import { NextResponse } from "next/server";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { resolveSignedIn } from "@/lib/http/services";
import { limitByIp, limitByUser, userRateLimitSubject } from "@/lib/rate-limit";
import { cleanSellerAnswer } from "@/lib/seller-profile";

export const dynamic = "force-dynamic";

const BAD_ANSWER = "Pick from the listed answers, or skip the questions.";

export async function PUT(request: Request): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const ipLimited = await limitByIp(request, "workspace.profile");
  if (ipLimited) {
    return ipLimited;
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: BAD_ANSWER }, { status: 400 });
  }
  const answer = cleanSellerAnswer(raw);
  if (!answer) {
    return NextResponse.json({ error: BAD_ANSWER }, { status: 400 });
  }
  const resolved = await resolveSignedIn("Sign in to save your answers.");
  if ("response" in resolved) {
    return resolved.response;
  }
  const userLimited = await limitByUser("workspace.profile", await userRateLimitSubject(resolved.workspace.id));
  if (userLimited) {
    return userLimited;
  }
  const result = await resolved.services.saveSellerProfile(resolved.workspace.id, answer);
  if (!result.ok) {
    return NextResponse.json({ error: result.notice }, { status: result.reason === "forbidden" ? 403 : 400 });
  }
  return NextResponse.json({ ok: true, notice: result.notice, profile: answer });
}
