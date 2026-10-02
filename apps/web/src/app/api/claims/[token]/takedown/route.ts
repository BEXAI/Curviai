/**
 * POST /api/claims/[token]/takedown (docs/phases/PHASE_18.md P18-04): the
 * footer link on a prospect's share page. Whoever holds the claim link can
 * take the page down: the share page goes private and the claim can no
 * longer be redeemed. 200 { status: "taken_down" | "already" }, 404 for a
 * token that matches no claim. No sign in; a cross site Origin is refused
 * and the route is rate limited by IP.
 */

import { NextResponse } from "next/server";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { CLAIM_COPY } from "@/lib/prospects/copy";
import { takeDownByToken } from "@/lib/prospects/store";
import { cleanClaimToken } from "@/lib/prospects/token";
import { limitByIp } from "@/lib/rate-limit";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ token: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const ipLimited = await limitByIp(request, "claims.takedown");
  if (ipLimited) {
    return ipLimited;
  }
  const { token: raw } = await context.params;
  const token = cleanClaimToken(raw);
  if (!token || !isDbMode()) {
    return NextResponse.json({ error: CLAIM_COPY.notFound, reason: "not_found" }, { status: 404 });
  }
  const outcome = await takeDownByToken(getDb(), { token, now: new Date() });
  if (outcome === "not_found") {
    return NextResponse.json({ error: CLAIM_COPY.notFound, reason: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ status: outcome, message: CLAIM_COPY.done });
}
