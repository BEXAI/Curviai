/**
 * /api/ops/prospects (docs/phases/PHASE_18.md P18-04), operators only
 * (OPS_EMAILS, founder decision 15); everyone else gets a 404.
 * GET: the operator's prospect packs, newest first, publishing any pack that
 * just finished (link only, measured checks on), and this month's prospect
 * credits: { prospects, credits: { usedThisMonth, cap, balance } }.
 * POST { store, productUrl?, title?, note?, channels, upload, idempotencyKey }:
 * makes a prospect pack in the operator's workspace through the normal
 * createJob path (every cap, rule and charge applies) from a photo already
 * uploaded or imported into that workspace, and records its claim.
 *
 * Writes refuse a cross site Origin and are rate limited like a new pack.
 */

import { NextResponse } from "next/server";
import { InlineRunnerClosedError } from "@/lib/jobs/inline-runner";
import { JOB_BODY_MAX_BYTES, readJsonCapped } from "@/lib/http/json-body";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { prospectCreditStatus } from "@/lib/prospects/credits";
import { resolveOperator } from "@/lib/prospects/operator";
import { createProspectPack, CreateProspectRequest, prospectsWithPublishing } from "@/lib/prospects/service";
import { limitByIp, limitByUser } from "@/lib/rate-limit";
import { RESTARTING_MESSAGE } from "@/lib/services/errors";
import { RETRY_AFTER_SECONDS } from "@/lib/services/workspace-response";
import { getShareStore } from "@/lib/shares";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const ctx = await resolveOperator();
  if ("response" in ctx) {
    return ctx.response;
  }
  const now = new Date();
  const [prospects, credits] = await Promise.all([
    prospectsWithPublishing(ctx, getShareStore(), now),
    prospectCreditStatus(ctx.db, ctx.workspace.id, now),
  ]);
  return NextResponse.json({ prospects, credits: { ...credits, balance: ctx.workspace.creditBalance } });
}

export async function POST(request: Request): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const ipLimited = await limitByIp(request, "jobs.create");
  if (ipLimited) {
    return ipLimited;
  }
  const ctx = await resolveOperator();
  if ("response" in ctx) {
    return ctx.response;
  }
  const userLimited = await limitByUser("jobs.create", `user:${ctx.userId}`);
  if (userLimited) {
    return userLimited;
  }
  const body = await readJsonCapped(request, JOB_BODY_MAX_BYTES);
  if (!body.ok) {
    return body.response;
  }
  const parsed = CreateProspectRequest.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request.", reason: "invalid" }, { status: 400 });
  }
  try {
    const result = await createProspectPack(ctx, parsed.data);
    if (!result.ok) {
      return NextResponse.json({ error: result.error, reason: result.reason }, { status: result.status });
    }
    return NextResponse.json({ prospect: result.prospect, jobId: result.jobId }, { status: result.created ? 201 : 200 });
  } catch (err) {
    if (err instanceof InlineRunnerClosedError) {
      return NextResponse.json(
        { error: RESTARTING_MESSAGE, reason: "unavailable" },
        { status: 503, headers: { "Retry-After": RETRY_AFTER_SECONDS } },
      );
    }
    throw err;
  }
}
