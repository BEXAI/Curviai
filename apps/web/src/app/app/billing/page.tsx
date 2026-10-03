import type { Metadata } from "next";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@curvi/ui";
import { tierByKey, topUps } from "@curvi/pipeline/seed";
import {
  CadenceSwitchLink,
  CheckoutButton,
  CheckoutReturnNotice,
  PlanFeatureList,
  PlanPicker,
  PortalButton,
  RequestPlanButton,
  type PlanActionMode,
} from "@/components/app/billing-actions";
import { CancelFlow } from "@/components/app/cancel-flow";
import { BillingHistory } from "@/components/app/billing-history";
import { CreditPlanning } from "@/components/app/credit-planning";
import { readCreditPlanning, demoCreditPlanning } from "@/lib/billing/credit-planning";
import { getDb } from "@/lib/services/db";
import { ScheduledPlanButton } from "@/components/app/scheduled-plan";
import { RenewalTerms } from "@/components/marketing/renewal-terms";
import { hasStripeApiKey, isCheckoutOpen } from "@/lib/env";
import { canManageBilling } from "@/lib/billing/access";
import {
  hasOpenSubscription,
  isCheckoutConfirmed,
  loadBillingAccount,
  type SubscriptionView,
} from "@/lib/billing/account";
import { cancelTier } from "@/lib/billing/cancel-service";
import { loadCancelState } from "@/lib/billing/cancel-store";
import { billingCheckoutHref, parseCheckoutIntent, parseCheckoutStatus, type CheckoutIntent } from "@/lib/billing/intent";
import {
  annualSavingsUsd,
  formatCredits,
  formatUsd,
  isPaidTierKey,
  planChangeDirection,
  priceForCadence,
  tierDisplayName,
  type BillingCadence,
  type PlanPrice,
} from "@/lib/billing/plans";
import { firstRenewal, showTaxLine, TAX_LINE } from "@/lib/billing/renewal-terms";
import { isStripeTaxEnabled } from "@/lib/billing/stripe";
import { needsCardUpdate, pastDueMessage } from "@/lib/billing/subscription-status";
import { CREDIT_TERMS_SENTENCE } from "@/lib/marketing-facts";
import { getServices, isDbMode } from "@/lib/services";

export const metadata: Metadata = { title: "Billing" };

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

const STATUS_LABELS: Record<string, { label: string; variant: "success" | "warning" | "danger" | "default" }> = {
  active: { label: "Active", variant: "success" },
  trialing: { label: "Trial", variant: "success" },
  past_due: { label: "Payment failed", variant: "danger" },
  unpaid: { label: "Unpaid", variant: "danger" },
  paused: { label: "Paused", variant: "warning" },
  incomplete: { label: "Waiting for payment", variant: "warning" },
  canceled: { label: "Canceled", variant: "default" },
};

function formatDate(iso: string | null): string | null {
  if (!iso) {
    return null;
  }
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function first(value: string | string[] | undefined): string | null {
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

export default async function BillingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const services = getServices();
  const workspace = await services.ensureWorkspace();
  if (!workspace) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-bold text-ink-950">Sign in to manage billing</h1>
      </div>
    );
  }

  const account = await loadBillingAccount(workspace.id, { refreshSchedule: canManageBilling(workspace.role) });
  const planName = tierDisplayName(workspace.plan);
  const stripeLive = isCheckoutOpen();
  const canBill = canManageBilling(workspace.role);
  const planning = canBill ? isDbMode() ? await readCreditPlanning(getDb(), workspace.id) : demoCreditPlanning(workspace.creditBalance) : null;
  // The portal needs only the API key and a customer (portal/route.ts), so
  // a subscriber can update a card or cancel even while checkout is closed
  // by a readiness problem (law and copy review major 6).
  const portalOpen = canBill && hasStripeApiKey() && Boolean(account.stripeCustomerId);
  const subscribed = hasOpenSubscription(account);
  const subscription = account.subscription;
  const pastDue = needsCardUpdate(subscription?.status);
  const subscribedPlanName = subscription?.tier ? tierDisplayName(subscription.tier) : planName;
  const mode: PlanActionMode = !canBill ? "none" : stripeLive ? "checkout" : "request";
  const cancelPlan = canBill ? cancelTier(workspace, account) : null;
  const cancelState = cancelPlan ? await loadCancelState(workspace.id) : null;
  const status = parseCheckoutStatus(params.status);
  const intent = parseCheckoutIntent({ checkout: params.checkout, cadence: params.cadence });
  const returnKind = first(params.kind);
  const confirmed =
    status === "success"
      ? await isCheckoutConfirmed({
          workspaceId: workspace.id,
          plan: workspace.plan,
          kind: returnKind,
          sessionId: first(params.session_id),
          account,
        })
      : null;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink-950">Billing</h1>
        <p className="mt-1 text-sm text-ink-500">
          {workspace.creditBalance < 0
            ? `You are on the ${planName} plan with a balance ${formatCredits(-workspace.creditBalance)} below zero.`
            : `You are on the ${planName} plan with ${formatCredits(workspace.creditBalance)}.`}
        </p>
      </div>

      {status ? (
        <CheckoutReturnNotice
          status={status}
          kind={returnKind}
          plan={workspace.plan}
          creditBalance={workspace.creditBalance}
          confirmed={confirmed}
        />
      ) : null}

      {pastDue ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4" role="alert" data-testid="past-due-banner">
          <p className="text-sm font-semibold text-red-900">Your last payment did not go through.</p>
          <p className="mt-1 text-sm text-red-800">{pastDueMessage(subscription?.status, subscribedPlanName, canBill)}</p>
          {portalOpen ? (
            <div className="mt-3">
              <PortalButton label="Update card" variant="primary" />
            </div>
          ) : null}
        </div>
      ) : null}

      {workspace.creditBalance < 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4" role="status" data-testid="negative-balance">
          <p className="text-sm font-semibold text-amber-900">Your credit balance is below zero.</p>
          <p className="mt-1 text-sm text-amber-800">
            A plan change returned money for time you had already been billed for, so the credits that time paid for
            were taken back, including some you had already used. New packs can start again once a top up or your
            next renewal brings the balance back up.
          </p>
        </div>
      ) : null}

      {!canBill ? (
        <div className="rounded-xl border border-ink-100 bg-ink-50 p-4 text-sm text-ink-700" data-testid="billing-role-notice">
          Only the workspace owner or an admin can change billing. Ask them for any change.
        </div>
      ) : null}

      {canBill && !stripeLive ? (
        <div className="rounded-xl border border-accent-200 bg-accent-50 p-4 text-sm text-ink-800" data-testid="billing-not-open">
          <p className="font-semibold text-ink-900">Card payments are not open yet.</p>
          <p className="mt-1">
            You can keep using your credits in the meantime. Pick a plan below and choose Request, and we will email
            you as soon as you can finish upgrading.
          </p>
        </div>
      ) : null}

      {intent && canBill ? (
        <FinishUpgradeCard
          intent={intent}
          currentPlan={workspace.plan}
          currentCadence={subscription?.cadence ?? null}
          subscribed={subscribed}
          stripeLive={stripeLive}
          taxEnabled={stripeLive && showTaxLine(isStripeTaxEnabled())}
          now={new Date()}
        />
      ) : null}

      <CurrentPlanCard
        planName={planName}
        creditBalance={workspace.creditBalance}
        subscription={subscription}
        canManage={portalOpen}
      />

      <section>
        <h2 className="text-lg font-semibold text-ink-950">Plans</h2>
        <p className="mt-1 text-sm text-ink-500">
          {subscribed
            ? "Moving to a bigger plan opens the Stripe customer portal, where you confirm the new plan and any prorated charge. Smaller plans and changes from yearly to monthly billing start at your next renewal."
            : `Every plan buys credits. ${CREDIT_TERMS_SENTENCE}`}
        </p>
        <div className="mt-4">
          <PlanPicker
            currentPlan={workspace.plan}
            hasSubscription={subscribed}
            currentCadence={subscription?.cadence ?? null}
            mode={mode}
            initialCadence={intent?.cadence}
            today={new Date().toISOString()}
          />
          {stripeLive && showTaxLine(isStripeTaxEnabled()) ? (
            <p className="mt-3 text-sm text-ink-500" data-testid="tax-line">
              {TAX_LINE}
            </p>
          ) : null}
        </div>
      </section>

      <section id="top-ups">
        <h2 className="text-lg font-semibold text-ink-950">Top ups</h2>
        <p className="mt-1 text-sm text-ink-500" data-testid="top-up-terms">
          One time credit packs on top of any plan, including Free. {CREDIT_TERMS_SENTENCE}
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:max-w-2xl">
          {topUps.map((topUp) => (
            <Card key={topUp.credits}>
              <CardContent className="p-5">
                <p className="font-medium text-ink-900">
                  {formatCredits(topUp.credits)} for {formatUsd(topUp.usd)}
                </p>
                <div className="mt-4">
                  {mode === "checkout" ? (
                    <CheckoutButton
                      label={`Buy ${topUp.credits} credits`}
                      body={{ kind: "topup", credits: topUp.credits, source: "billing" }}
                      variant="outline"
                    />
                  ) : mode === "request" ? (
                    <RequestPlanButton
                      label={`Request ${topUp.credits} credits`}
                      body={{ kind: "topup", credits: topUp.credits }}
                      variant="outline"
                    />
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {planning ? <CreditPlanning initial={planning} canChange={workspace.role === "owner"} demo={!isDbMode()} /> : null}
      <BillingHistory canViewInvoices={canBill} />

      {cancelPlan ? (
        <section id="cancel-plan" data-testid="cancel-section">
          <h2 className="text-lg font-semibold text-ink-950">Cancel plan</h2>
          {cancelState?.pending?.outcome === "canceled" ? (
            <p className="mt-1 text-sm text-ink-600" data-testid="cancel-pending">
              {`Your ${tierDisplayName(cancelPlan)} plan is set to end on ${formatDate(cancelState.pending.effectiveAt)}. Open the customer portal to renew it.`}
            </p>
          ) : cancelState?.pending ? (
            <>
              <p className="mt-1 text-sm text-ink-600" data-testid="cancel-pending">
                {`Billing is paused until ${formatDate(cancelState.pending.effectiveAt)}. Your plan and credits stay as they are. You can still cancel.`}
              </p>
              <div className="mt-4">
                <CancelFlow planName={tierDisplayName(cancelPlan)} />
              </div>
            </>
          ) : (
            <>
              <p className="mt-1 text-sm text-ink-500">
                You can cancel any time. Your plan stays active until the end of the period you paid for.
              </p>
              <div className="mt-4">
                <CancelFlow planName={tierDisplayName(cancelPlan)} />
              </div>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}

function CurrentPlanCard({
  planName,
  creditBalance,
  subscription,
  canManage,
}: {
  planName: string;
  creditBalance: number;
  subscription: SubscriptionView | null;
  canManage: boolean;
}) {
  const statusInfo = subscription ? STATUS_LABELS[subscription.status] : undefined;
  const periodEnd = formatDate(subscription?.periodEnd ?? null);
  let periodLine: string | null = null;
  if (subscription && periodEnd) {
    if (subscription.status === "active" || subscription.status === "trialing") {
      periodLine = `Renews on ${periodEnd}.`;
    } else if (subscription.status === "canceled") {
      periodLine = `Ended on ${periodEnd}.`;
    } else {
      periodLine = `Current period ends on ${periodEnd}.`;
    }
  }

  return (
    <Card data-testid="current-plan">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Current plan: {planName}</CardTitle>
          {statusInfo ? <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge> : null}
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-ink-600">
          {creditBalance < 0
            ? `Balance ${formatCredits(-creditBalance)} below zero.`
            : `${formatCredits(creditBalance)} available.`}
        </p>
        {periodLine ? <p className="mt-1 text-sm text-ink-600">{periodLine}</p> : null}
        {subscription?.pending ? <div className="mt-3 space-y-2" data-testid="pending-plan-change">
          <p className="text-sm text-ink-600">Your plan changes to {tierDisplayName(subscription.pending.tier)}, billed {subscription.pending.cadence === "annual" ? "yearly" : "monthly"}, on {formatDate(subscription.pending.at)}. Until then you keep {planName} and its credits.</p>
          {canManage ? <ScheduledPlanButton label={`Keep ${planName}`} /> : null}
        </div> : null}
        {!subscription?.pending && subscription?.attachedScheduleId ? <div className="mt-3 space-y-2">
          <p className="text-sm text-ink-600">A billing schedule is attached to this plan. Keep your current plan to cancel its future changes.</p>
          {canManage ? <ScheduledPlanButton label={`Keep ${planName}`} /> : null}
        </div> : null}
        {subscription?.scheduleSyncFailed ? <p className="mt-3 text-sm text-ink-600">We could not confirm scheduled changes with Stripe. Refresh Billing before choosing another change.</p> : null}
        {!subscription ? (
          <p className="mt-1 text-sm text-ink-500">No subscription yet. Pick a plan below when you are ready.</p>
        ) : null}
        {canManage ? (
          <div className="mt-4">
            <p className="mb-2 text-sm text-ink-500">Update cards and download invoices in the customer portal.</p>
            <PortalButton />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function FinishUpgradeCard({
  intent,
  currentPlan,
  currentCadence,
  subscribed,
  stripeLive,
  taxEnabled,
  now,
}: {
  intent: CheckoutIntent;
  currentPlan: string;
  currentCadence: BillingCadence | null;
  subscribed: boolean;
  stripeLive: boolean;
  taxEnabled: boolean;
  now: Date;
}) {
  const tier = tierByKey(intent.tier);
  const name = tierDisplayName(intent.tier);
  const price = priceForCadence(tier, intent.cadence);
  const otherCadence = intent.cadence === "annual" ? "monthly" : "annual";
  // P20-06 stopgap: a subscriber's change follows planChangeDirection, so a
  // yearly to monthly move (even onto a bigger plan) is an email, not a
  // button, and a monthly to yearly move on the same plan is an upgrade.
  const from: PlanPrice | null =
    subscribed && isPaidTierKey(currentPlan) ? { tier: currentPlan, cadence: currentCadence ?? "monthly" } : null;
  const target: PlanPrice = { tier: intent.tier, cadence: intent.cadence };
  const direction = from ? planChangeDirection(from, target) : null;
  const alreadyOnPlan = direction === "same";
  const byEmail = direction === "downgrade" && stripeLive;

  return (
    <Card className="border-accent-500 shadow-md" data-testid="finish-upgrade">
      <CardHeader>
        <CardTitle>
          {alreadyOnPlan
            ? `You are on the ${name} plan`
            : from?.tier === intent.tier
              ? `Switch ${name} to ${intent.cadence === "annual" ? "yearly" : "monthly"} billing`
              : `Finish upgrading to ${name}`}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="flex items-baseline gap-1">
          <span className="text-3xl font-bold tracking-tight text-ink-950">{formatUsd(price.perMonthUsd)}</span>
          <span className="text-sm text-ink-500">per month</span>
        </p>
        <p className="mt-1 text-sm text-ink-600">
          {intent.cadence === "annual"
            ? `Billed ${formatUsd(price.billedUsd)} once a year, with ${formatCredits(price.creditsPerInvoice)} added up front.`
            : `Billed ${formatUsd(price.billedUsd)} each month, with ${formatCredits(price.creditsPerInvoice)} added each month.`}
          {taxEnabled ? ` ${TAX_LINE}` : ""}
        </p>
        <PlanFeatureList tier={intent.tier} />
        <div className="mt-5 max-w-sm">
          {alreadyOnPlan ? (
            stripeLive ? (
              <PortalButton label="Manage plan" />
            ) : null
          ) : byEmail ? (
            <ScheduledPlanButton label={`Switch to ${name} at renewal`} target={target} />
          ) : stripeLive ? (
            <CheckoutButton
              label={
                !subscribed
                  ? "Continue to payment"
                  : from?.tier === intent.tier
                    ? "Switch to yearly billing in the customer portal"
                    : `Switch to ${name} in the customer portal`
              }
              body={{ kind: "tier", tier: intent.tier, cadence: intent.cadence, source: "finish_upgrade" }}
            />
          ) : (
            <RequestPlanButton
              label={`Request ${name}`}
              body={{ kind: "tier", tier: intent.tier, cadence: intent.cadence }}
            />
          )}
        </div>
        {!alreadyOnPlan ? (
          <RenewalTerms
            tier={intent.tier}
            cadence={intent.cadence}
            renewsOn={subscribed ? null : firstRenewal(now, intent.cadence)}
            className="max-w-xl"
          />
        ) : null}
        {!alreadyOnPlan ? (
          <p className="mt-3">
            <CadenceSwitchLink
              href={billingCheckoutHref({ tier: intent.tier, cadence: otherCadence })}
              label={
                otherCadence === "annual"
                  ? `Pay annually instead and save ${formatUsd(annualSavingsUsd(tier))} a year`
                  : "Pay monthly instead"
              }
            />
          </p>
        ) : null}
        {subscribed && !alreadyOnPlan && !byEmail && stripeLive ? (
          <p className="mt-3 text-xs text-ink-500">
            You already have a subscription, so the change is confirmed in the Stripe customer portal, which shows any
            prorated charge before you agree.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
