/**
 * POST /api/ops/prospects/credits { credits } (docs/phases/PHASE_18.md
 * P18-04), operators only; everyone else gets a 404. Adds prospect credits
 * to the operator's own workspace as a `grant` ledger row with source
 * `system`, never past the seeded monthly cap (staffMonthlyCreditCap):
 * 200 { credits: { usedThisMonth, cap, balance }, added }, or 409 with how
 * many are left this month. Same origin and rate limited.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonCapped } from "@/lib/http/json-body";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { PROSPECT_PAGE_COPY } from "@/lib/prospects/copy";
import { addProspectCredits } from "@/lib/prospects/credits";
import { resolveOperator } from "@/lib/prospects/operator";
import { limitByIp, limitByUser } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const CreditsRequest = z.object({ credits: z.number() });

export async function POST(request: Request): Promise<NextResponse> {
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
  const body = await readJsonCapped(request);
  if (!body.ok) {
    return body.response;
  }
  const parsed = CreditsRequest.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json({ error: PROSPECT_PAGE_COPY.creditsInvalid, reason: "invalid" }, { status: 400 });
  }
  const result = await addProspectCredits(ctx.db, {
    workspaceId: ctx.workspace.id,
    userId: ctx.userId,
    credits: parsed.data.credits,
    now: new Date(),
  });
  switch (result.outcome) {
    case "invalid":
      return NextResponse.json({ error: PROSPECT_PAGE_COPY.creditsInvalid, reason: "invalid" }, { status: 400 });
    case "over_cap":
      return NextResponse.json(
        { error: PROSPECT_PAGE_COPY.creditsOverCap(result.left), reason: "over_cap", credits: result.status },
        { status: 409 },
      );
    case "added":
      return NextResponse.json({
        added: result.credits,
        credits: { ...result.status, balance: ctx.workspace.creditBalance + result.credits },
      });
  }
}
