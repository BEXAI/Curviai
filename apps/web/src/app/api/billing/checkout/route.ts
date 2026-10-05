/**
 * POST /api/billing/checkout
 * Starts a Stripe Checkout session for a tier subscription or a credit top
 * up, or, for a workspace that already has a subscription, opens the Customer
 * Portal on the plan change so no second subscription is ever created.
 *
 * The workspace's Stripe customer is created and stored before Checkout, and
 * a tier purchase checks Stripe itself and expires older open tier sessions
 * under a per workspace lock (lib/billing/checkout-guard.ts).
 *
 * Answers:
 * - 401 signed out, 403 for the client role (plan 4.3, Update.md 4.4).
 * - 409 downgrade_by_email when an existing subscriber picks a smaller plan
 *   or a monthly price from a yearly one (even on a bigger plan): until
 *   P20-06's P1 schedule, the founder sets it up for the next renewal by
 *   email. Upgrades open the portal with the upgrade only configuration of
 *   the subscriber's current plan and cadence.
 * - 409 scheduled_change_pending when an upgrade would cancel a change the
 *   founder scheduled for the renewal: the notice says so, and the same
 *   request with releaseScheduledChange: true goes ahead (the release is
 *   recorded and emailed to the founder).
 * - 400 tier_not_self_serve for a tier the seed keeps off self serve
 *   (Agency, docs/phases/PHASE_20.md P20-08): it is set up by email.
 * - 503 billing_not_configured while checkout is closed: a key, the webhook
 *   secret or a self serve price is missing, or the key mode does not fit
 *   the environment (lib/billing/readiness.ts, P20-01). The billing page
 *   shows an honest notice and a request button instead of calling this.
 *
 * Every Stripe URL handed out records checkout:last_opened in
 * platform_settings, which /api/health compares with the last webhook
 * success (stripe_webhook_quiet).
 * - 200 { url, via: "checkout" | "portal" } otherwise.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { topUps } from "@curvi/pipeline/seed";
import { isCheckoutOpen, siteUrl } from "@/lib/env";
import { BILLING_FORBIDDEN_NOTICE, canManageBilling } from "@/lib/billing/access";
import { hasOpenSubscription, loadBillingAccount } from "@/lib/billing/account";
import {
  buildCheckoutParams,
  createPlanChangePortalSession,
  DOWNGRADE_BY_EMAIL_LINE,
  planChangeDisclosure,
  type CheckoutPurchase,
  type PlanChangeResult,
} from "@/lib/billing/checkout";
import {
  ensureStripeCustomer,
  openTierCheckout,
  STRIPE_CHECKOUT_OPTIONS,
  withCheckoutLock,
} from "@/lib/billing/checkout-guard";
import { claimStripeCustomer, DbBillingStore } from "@/lib/billing/db-store";
import { CHECKOUT_SOURCES } from "@/lib/billing/intent";
import { liveScheduleReleaseNotifier } from "@/lib/billing/schedule-release";
import { CHECKOUT_OPENED_KEY, recordBillingSignal } from "@/lib/billing/signals";
import {
  isPaidTierKey,
  isSelfServeTierKey,
  LARGER_PLAN_EMAIL,
  LARGER_PLAN_LINE,
  type PaidTierKey,
} from "@/lib/billing/plans";
import { priceIdForTier, priceIdForTopUp } from "@/lib/billing/price-table";
import { getStripe, isStripeTaxEnabled } from "@/lib/billing/stripe";
import { readJsonCapped } from "@/lib/http/json-body";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { resolveSignedIn } from "@/lib/http/services";
import { isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { getSessionUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const topUpCredits = topUps.map((t) => t.credits);

const Source = z.enum(CHECKOUT_SOURCES).default("billing");

const CheckoutRequest = z.union([
  z.object({
    kind: z.literal("tier"),
    tier: z.string().refine((value) => isPaidTierKey(value), { message: "Unknown tier." }),
    cadence: z.enum(["monthly", "annual"]),
    source: Source,
    /** The subscriber confirmed that this upgrade cancels the change the
     * founder scheduled for their renewal (409 scheduled_change_pending). */
    releaseScheduledChange: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("topup"),
    credits: z.number().refine((value) => topUpCredits.includes(value), { message: "Unknown top up." }),
    source: Source,
  }),
]);

const STRIPE_ERROR_NOTICE = "Stripe could not open checkout just now. Try again in a minute.";

/** P20-06 stopgap: a smaller plan, or yearly to monthly billing, is set up
 * by email for the next renewal. */
function downgradeByEmail(line: string = DOWNGRADE_BY_EMAIL_LINE): NextResponse {
  return NextResponse.json(
    { error: "downgrade_by_email", notice: `${line} Write to ${LARGER_PLAN_EMAIL}.` },
    { status: 409 },
  );
}

/**
 * The consent row for a plan change opened in the portal (law and copy
 * review major 3): the renewal terms that sat beside the button, who
 * clicked, and the portal session. Never throws: the portal link is already
 * made, and a lost row is logged for the founder.
 */
async function recordPlanChangeConsent(input: {
  dbMode: boolean;
  workspaceId: string;
  customerId: string;
  change: Extract<PlanChangeResult, { kind: "portal" }>;
}): Promise<void> {
  const { change } = input;
  if (!input.dbMode || !change.upgrade || !change.sessionId) {
    return;
  }
  try {
    const buyer = await getSessionUser().catch(() => null);
    const disclosure = planChangeDisclosure(change.upgrade);
    await new DbBillingStore(getDb(), "stripe").recordPlanChangeConsent({
      workspaceId: input.workspaceId,
      userId: buyer?.id ?? null,
      email: buyer?.email ?? null,
      stripeCustomerId: input.customerId,
      portalSessionId: change.sessionId,
      tier: change.upgrade.tier,
      cadence: change.upgrade.cadence,
      disclosureVersion: disclosure.version,
      disclosureSha256: disclosure.sha256,
      disclosureText: disclosure.text,
      acceptedAt: new Date(),
    });
  } catch (error) {
    console.error(
      JSON.stringify({ msg: "billing: plan change consent not recorded", workspaceId: input.workspaceId, error: String(error) }),
    );
  }
}

/** P20-06 stopgap: an upgrade would release the change the founder
 * scheduled, so the subscriber confirms first (Continue resends the request
 * with releaseScheduledChange). */
function scheduledChangePending(notice: string): NextResponse {
  return NextResponse.json({ error: "scheduled_change_pending", notice, confirmLabel: "Continue" }, { status: 409 });
}

/** Never throws (lib/billing/signals.ts). */
async function recordCheckoutOpened(dbMode: boolean): Promise<void> {
  if (dbMode) {
    await recordBillingSignal(getDb(), CHECKOUT_OPENED_KEY);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const crossSite = sameOriginOrRefuse(request);
  if (crossSite) {
    return crossSite;
  }
  const resolved = await resolveSignedIn("Sign in to manage billing.", { ensure: true });
  if ("response" in resolved) {
    return resolved.response;
  }
  const { workspace } = resolved;
  if (!canManageBilling(workspace.role)) {
    return NextResponse.json({ error: "billing_forbidden", notice: BILLING_FORBIDDEN_NOTICE }, { status: 403 });
  }

  const body = await readJsonCapped(request);
  if (!body.ok) {
    return body.response;
  }
  const parsed = CheckoutRequest.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request.", issues: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }

  if (parsed.data.kind === "tier" && !isSelfServeTierKey(parsed.data.tier)) {
    return NextResponse.json(
      { error: "tier_not_self_serve", notice: `${LARGER_PLAN_LINE} Write to ${LARGER_PLAN_EMAIL}.` },
      { status: 400 },
    );
  }

  if (!isCheckoutOpen()) {
    return NextResponse.json(
      {
        error: "billing_not_configured",
        notice: "Card payments are not open yet. Use Request this plan on the Billing page and we will email you when they open.",
      },
      { status: 503 },
    );
  }

  const data = parsed.data;
  const purchase: CheckoutPurchase =
    data.kind === "tier"
      ? { kind: "tier", tier: data.tier as PaidTierKey, cadence: data.cadence }
      : { kind: "topup", credits: data.credits };
  const priceId =
    purchase.kind === "tier" ? priceIdForTier(purchase.tier, purchase.cadence) : priceIdForTopUp(purchase.credits);
  if (!priceId) {
    return NextResponse.json(
      {
        error: "price_not_configured",
        notice: "This option cannot be bought online yet. Email support@curvi.ai and we will set it up.",
      },
      { status: 503 },
    );
  }

  const account = await loadBillingAccount(workspace.id);
  const stripe = getStripe();
  const dbMode = isDbMode();
  const releaseScheduledChange = data.kind === "tier" && data.releaseScheduledChange === true;
  const notifyRelease = liveScheduleReleaseNotifier({ db: dbMode ? getDb() : null });

  if (purchase.kind === "tier" && hasOpenSubscription(account)) {
    const subscriptionId = account.subscription?.externalId ?? null;
    if (!account.stripeCustomerId || !subscriptionId) {
      return NextResponse.json(
        {
          error: "subscription_exists",
          notice: "This workspace already has a subscription. Email support@curvi.ai and we will change the plan for you.",
        },
        { status: 409 },
      );
    }
    try {
      const change = await createPlanChangePortalSession(
        stripe,
        {
          customerId: account.stripeCustomerId,
          subscriptionId,
          priceId,
          returnUrl: `${siteUrl()}/app/billing`,
          releaseScheduledChange,
        },
        {
          onScheduleReleased: (released) =>
            notifyRelease({ workspaceId: workspace.id, subscriptionId, change: released, path: "upgrade" }),
        },
      );
      if (change.kind === "downgrade_by_email") {
        return downgradeByEmail(change.line);
      }
      if (change.kind === "scheduled_change") {
        return scheduledChangePending(change.notice);
      }
      await recordPlanChangeConsent({ dbMode, workspaceId: workspace.id, customerId: account.stripeCustomerId, change });
      await recordCheckoutOpened(dbMode);
      return NextResponse.json({ url: change.url, via: "portal" });
    } catch (error) {
      console.error(JSON.stringify({ msg: "billing: plan change portal failed", workspaceId: workspace.id, error: String(error) }));
      return NextResponse.json({ error: "stripe_error", notice: STRIPE_ERROR_NOTICE }, { status: 502 });
    }
  }

  // The buyer, for a new customer's email and the consent record (P20-07).
  const buyer = dbMode ? await getSessionUser().catch(() => null) : null;
  let customerId: string;
  try {
    const email = account.stripeCustomerId ? null : (buyer?.email ?? null);
    customerId = await ensureStripeCustomer(stripe, {
      workspaceId: workspace.id,
      email,
      storedCustomerId: account.stripeCustomerId,
      claim: dbMode ? (id) => claimStripeCustomer(getDb(), workspace.id, id) : async (id) => id,
      reread: dbMode ? async () => (await loadBillingAccount(workspace.id)).stripeCustomerId : async () => null,
    });
  } catch (error) {
    console.error(JSON.stringify({ msg: "billing: customer create failed", workspaceId: workspace.id, error: String(error) }));
    return NextResponse.json({ error: "stripe_error", notice: STRIPE_ERROR_NOTICE }, { status: 502 });
  }

  const params = buildCheckoutParams({
    purchase,
    priceId,
    workspaceId: workspace.id,
    siteUrl: siteUrl(),
    source: data.source,
    customerId,
    taxEnabled: isStripeTaxEnabled(),
    userId: buyer?.id ?? null,
  });

  try {
    if (purchase.kind === "tier") {
      const result = await withCheckoutLock(dbMode ? getDb() : null, workspace.id, () =>
        openTierCheckout(stripe, {
          customerId,
          priceId,
          returnUrl: `${siteUrl()}/app/billing`,
          params,
          releaseScheduledChange,
          onScheduleReleased: (released, subscriptionId) =>
            notifyRelease({ workspaceId: workspace.id, subscriptionId, change: released, path: "upgrade" }),
        }),
      );
      if (result.via === "downgrade_by_email") {
        return downgradeByEmail(result.line);
      }
      if (result.via === "scheduled_change") {
        return scheduledChangePending(result.notice);
      }
      if (result.via === "portal") {
        if (result.change) {
          await recordPlanChangeConsent({ dbMode, workspaceId: workspace.id, customerId, change: result.change });
        }
        await recordCheckoutOpened(dbMode);
        return NextResponse.json({ url: result.url, via: "portal" });
      }
      await recordCheckoutOpened(dbMode);
      return NextResponse.json(result);
    }
    const session = await stripe.checkout.sessions.create(params, { ...STRIPE_CHECKOUT_OPTIONS });
    await recordCheckoutOpened(dbMode);
    return NextResponse.json({ url: session.url, via: "checkout" });
  } catch (error) {
    console.error(JSON.stringify({ msg: "billing: checkout session failed", workspaceId: workspace.id, error: String(error) }));
    return NextResponse.json({ error: "stripe_error", notice: STRIPE_ERROR_NOTICE }, { status: 502 });
  }
}
