/**
 * /api/ops/prospects/[id]/link (docs/phases/PHASE_18.md P18-04), operators
 * only; everyone else gets a 404. Rate limited.
 *
 * GET shows the outreach kit of a finished prospect pack again: the
 * checker's rows for the prospect's current listing photo, the pack's
 * fidelity summary, the store and product names for the draft note, and
 * the live claim link when the server can rebuild it (link null
 * otherwise). It never makes a new token, so the link already sent keeps
 * working for the claim and the takedown.
 *
 * POST (same origin) makes a fresh claim link (the old link stops working)
 * and returns it with the same kit. The operator sends the note from the
 * outreach domain; Curvi sends nothing to prospects.
 */

import { NextResponse } from "next/server";
import { publicOrigin } from "@/lib/http/public-origin";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { resolveOperator } from "@/lib/prospects/operator";
import { claimKit, makeClaimLink } from "@/lib/prospects/service";
import { getObjectBytes } from "@/lib/r2";
import { limitByIp, limitByUser } from "@/lib/rate-limit";
import { getShareStore } from "@/lib/shares";
import { isUuid } from "@/lib/validation/ids";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const ipLimited = await limitByIp(request, "ops.prospects");
  if (ipLimited) {
    return ipLimited;
  }
  const ctx = await resolveOperator();
  if ("response" in ctx) {
    return ctx.response;
  }
  const userLimited = await limitByUser("ops.prospects", `user:${ctx.userId}`);
  if (userLimited) {
    return userLimited;
  }
  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const result = await claimKit(ctx, { claimId: id, origin: publicOrigin(request), get: (key) => getObjectBytes(key) });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, reason: result.reason }, { status: result.status });
  }
  return NextResponse.json(
    { link: result.link, expiresAt: result.expiresAt, kit: result.kit },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const ipLimited = await limitByIp(request, "ops.prospects");
  if (ipLimited) {
    return ipLimited;
  }
  const ctx = await resolveOperator();
  if ("response" in ctx) {
    return ctx.response;
  }
  const userLimited = await limitByUser("ops.prospects", `user:${ctx.userId}`);
  if (userLimited) {
    return userLimited;
  }
  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const result = await makeClaimLink(ctx, getShareStore(), {
    claimId: id,
    origin: publicOrigin(request),
    get: (key) => getObjectBytes(key),
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, reason: result.reason }, { status: result.status });
  }
  return NextResponse.json({ link: result.link, expiresAt: result.expiresAt, kit: result.kit });
}
