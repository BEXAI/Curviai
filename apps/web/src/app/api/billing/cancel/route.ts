/**
 * /api/billing/cancel: the cancel flow with save offers on /app/billing.
 *
 * GET returns the reasons and the save offers this workspace may take (each
 * pause or discount once per workspace, pause and discount on monthly plans
 * only, a smaller plan when there is one).
 *
 * POST { reason, detail?, choice } records the reason and the outcome in
 * cancel_flows and, with Stripe configured and an open Stripe subscription,
 * applies it: pause_collection, a price change, the save offer coupon, or
 * cancel at period end. Without Stripe the choice is recorded only.
 *
 * Answers 401 signed out, 403 for the client role, 409 on Free, when a
 * pause or cancellation is already pending, or for an offer the workspace
 * may not take, 502 when Stripe refuses.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { BILLING_FORBIDDEN_NOTICE, canManageBilling } from "@/lib/billing/access";
import { loadBillingAccount } from "@/lib/billing/account";
import { CANCEL_REASON_KEYS, MAX_CANCEL_DETAIL } from "@/lib/billing/cancel-flow";
import { applyCancelChoice, cancelOptions } from "@/lib/billing/cancel-service";
import { liveCancelDeps } from "@/lib/billing/cancel-store";
import { readJsonCapped } from "@/lib/http/json-body";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { resolveSignedIn } from "@/lib/http/services";
import type { WorkspaceSummary } from "@/lib/services/types";
import { getSessionUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// No control characters or angle brackets in the free text reason.
const SAFE_TEXT = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F<>]*$/;

const CancelRequest = z.object({
  reason: z.enum(CANCEL_REASON_KEYS),
  detail: z.string().max(MAX_CANCEL_DETAIL).regex(SAFE_TEXT).optional().nullable(),
  choice: z.enum(["pause", "downgrade", "discount", "cancel", "keep"]),
});

async function billingWorkspace(): Promise<{ workspace: WorkspaceSummary } | { response: NextResponse }> {
  const resolved = await resolveSignedIn("Sign in to manage billing.", { ensure: true });
  if ("response" in resolved) {
    return resolved;
  }
  const { workspace } = resolved;
  if (!canManageBilling(workspace.role)) {
    return {
      response: NextResponse.json({ error: "billing_forbidden", notice: BILLING_FORBIDDEN_NOTICE }, { status: 403 }),
    };
  }
  return { workspace };
}

export async function GET(): Promise<NextResponse> {
  const resolved = await billingWorkspace();
  if ("response" in resolved) {
    return resolved.response;
  }
  const { workspace } = resolved;
  const account = await loadBillingAccount(workspace.id);
  const result = await cancelOptions(liveCancelDeps(), workspace, account);
  if (!result.ok) {
    return NextResponse.json({ error: result.error, notice: result.notice }, { status: result.status });
  }
  return NextResponse.json(result.options, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const resolved = await billingWorkspace();
  if ("response" in resolved) {
    return resolved.response;
  }
  const { workspace } = resolved;
  const body = await readJsonCapped(request);
  if (!body.ok) {
    return body.response;
  }
  const parsed = CancelRequest.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", notice: "Pick a reason and an option, and keep the note under 500 characters." },
      { status: 400 },
    );
  }
  const [account, user] = await Promise.all([loadBillingAccount(workspace.id), getSessionUser().catch(() => null)]);
  const result = await applyCancelChoice(liveCancelDeps(), {
    workspace,
    account,
    userId: user?.id ?? null,
    reason: parsed.data.reason,
    detail: parsed.data.detail ?? null,
    choice: parsed.data.choice,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, notice: result.notice }, { status: result.status });
  }
  return NextResponse.json({
    ok: true,
    outcome: result.outcome,
    notice: result.notice,
    stripeApplied: result.stripeApplied,
    effectiveAt: result.effectiveAt,
  });
}
