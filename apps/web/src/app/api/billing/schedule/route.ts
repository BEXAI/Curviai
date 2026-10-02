import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveSignedIn } from "@/lib/http/services";
import { readJsonCapped } from "@/lib/http/json-body";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { hasStripeApiKey, isCheckoutOpen } from "@/lib/env";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { loadBillingAccount } from "@/lib/billing/account";
import { BILLING_FORBIDDEN_NOTICE, canManageBilling } from "@/lib/billing/access";
import { withCheckoutLock } from "@/lib/billing/checkout-guard";
import { buildPriceTable, priceIdForTier } from "@/lib/billing/price-table";
import { getStripe } from "@/lib/billing/stripe";
import { clearPendingChange, recoverPendingSchedule, keepCurrentPlan, scheduleWorkspaceDowngrade, ScheduledChangeError } from "@/lib/billing/scheduled-change";

const RequestBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("keep") }).strict(),
  z.object({ action: z.literal("schedule"), tier: z.enum(["starter", "growth", "pro"]), cadence: z.enum(["monthly", "annual"]) }).strict(),
]);

export async function POST(request: Request): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) return crossSite;
  const resolved = await resolveSignedIn("Sign in to manage billing.", { ensure: true });
  if ("response" in resolved) return resolved.response;
  const { workspace } = resolved;
  if (!canManageBilling(workspace.role)) return NextResponse.json({ notice: BILLING_FORBIDDEN_NOTICE }, { status: 403 });
  const body = await readJsonCapped(request);
  if (!body.ok) return body.response;
  const parsed = RequestBody.safeParse(body.data);
  if (!parsed.success) return NextResponse.json({ notice: "Choose a valid plan change." }, { status: 400 });
  const data = parsed.data;
  if (!isDbMode() || !hasStripeApiKey() || (data.action === "schedule" && !isCheckoutOpen())) {
    return NextResponse.json({ notice: "Plan changes are not configured yet." }, { status: 503 });
  }
  try {
    const db = getDb();
    const stripe = getStripe();
    return await withCheckoutLock(db, workspace.id, async () => {
      const account = await loadBillingAccount(workspace.id);
      const current = account.subscription;
      if (!account.stripeCustomerId || !current?.externalId) throw new ScheduledChangeError("No active subscription was found.");
      if (data.action === "keep") {
        const attached = await recoverPendingSchedule(db, stripe, { workspaceId: workspace.id, subscriptionId: current.externalId, customerId: account.stripeCustomerId, prices: buildPriceTable() });
        if (attached) {
          await keepCurrentPlan(stripe, { subscriptionId: current.externalId, customerId: account.stripeCustomerId, scheduleId: attached.scheduleId });
          await clearPendingChange(db, attached.scheduleId, workspace.id);
        }
        return NextResponse.json({ ok: true, notice: "Your current plan will continue." });
      }
      const priceId = priceIdForTier(data.tier, data.cadence);
      if (!priceId) return NextResponse.json({ notice: "That price is not configured yet." }, { status: 503 });
      const change = await scheduleWorkspaceDowngrade(db, stripe, {
        workspaceId: workspace.id,
        subscriptionId: current.externalId, customerId: account.stripeCustomerId,
        targetPriceId: priceId, target: data, prices: buildPriceTable(), pendingScheduleId: current.pending?.scheduleId,
      });
      return NextResponse.json({ ok: true, startsAt: change.startsAt.toISOString(), notice: "Your plan change is scheduled for your next renewal." });
    });
  } catch (error) {
    if (error instanceof ScheduledChangeError) return NextResponse.json({ notice: error.message }, { status: 409 });
    console.error(JSON.stringify({ msg: "billing: scheduled change failed", workspaceId: workspace.id, error: String(error) }));
    return NextResponse.json({ notice: "The plan change could not be saved. Refresh Billing before trying again." }, { status: 502 });
  }
}
