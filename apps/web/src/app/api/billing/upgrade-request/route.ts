/**
 * POST /api/billing/upgrade-request
 * While card payments are not open (Stripe has no keys), the billing page
 * offers "Request this plan" instead of a dead end. The request is stored as
 * an upgrade_requested events row so the founder can follow up by email
 * (docs/STRIPE_SETUP.md lists the query). Top ups can be requested the same
 * way. One request per workspace, plan and cadence per day is kept; repeats
 * are acknowledged without a new row.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, events, sql } from "@curvi/db";
import { topUps } from "@curvi/pipeline/seed";
import { BILLING_FORBIDDEN_NOTICE, canManageBilling } from "@/lib/billing/access";
import { isPaidTierKey } from "@/lib/billing/plans";
import { getServices, isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { getSessionUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const topUpCredits = topUps.map((t) => t.credits);

const UpgradeRequest = z.union([
  z.object({
    kind: z.literal("tier").default("tier"),
    tier: z.string().refine((value) => isPaidTierKey(value), { message: "Unknown tier." }),
    cadence: z.enum(["monthly", "annual"]),
  }),
  z.object({
    kind: z.literal("topup"),
    credits: z.number().refine((value) => topUpCredits.includes(value), { message: "Unknown top up." }),
  }),
]);

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const parsed = UpgradeRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request.", issues: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }

  const workspace = await getServices().ensureWorkspace();
  if (!workspace) {
    return NextResponse.json({ error: "Sign in to manage billing." }, { status: 401 });
  }
  if (!canManageBilling(workspace.role)) {
    return NextResponse.json({ error: "billing_forbidden", notice: BILLING_FORBIDDEN_NOTICE }, { status: 403 });
  }

  const notice = "Request saved. We will email you as soon as you can finish upgrading.";
  if (!isDbMode()) {
    return NextResponse.json({ ok: true, notice });
  }

  const data = parsed.data;
  const requested =
    data.kind === "topup"
      ? { kind: "topup", tier: "topup", cadence: "one_time", credits: data.credits }
      : { kind: "tier", tier: data.tier, cadence: data.cadence, credits: null };

  const db = getDb();
  const recent = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.workspaceId, workspace.id),
        eq(events.name, "upgrade_requested"),
        sql`${events.props}->>'tier' = ${requested.tier}`,
        sql`${events.props}->>'cadence' = ${requested.cadence}`,
        sql`${events.at} > now() - interval '1 day'`,
      ),
    )
    .limit(1);
  if (recent.length === 0) {
    const user = await getSessionUser();
    await db.insert(events).values({
      workspaceId: workspace.id,
      name: "upgrade_requested",
      props: {
        ...requested,
        fromPlan: workspace.plan,
        email: user?.email ?? null,
      },
    });
  }
  return NextResponse.json({ ok: true, notice });
}
