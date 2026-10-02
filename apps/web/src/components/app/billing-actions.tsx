"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, cn } from "@curvi/ui";
import { OnTheWay } from "@/components/marketing/on-the-way";
import { ScheduledPlanButton } from "./scheduled-plan";
import { RenewalTerms } from "@/components/marketing/renewal-terms";
import { trackBillingEvent } from "@/lib/billing/analytics";
import type { CheckoutSource, CheckoutStatus } from "@/lib/billing/intent";
import { includedFeatures } from "@/lib/billing/plan-features";
import {
  annualSavingsUsd,
  formatCredits,
  formatUsd,
  isPaidTierKey,
  planChangeDirection,
  priceForCadence,
  selfServeTiers,
  tierDisplayName,
  type BillingCadence,
  type PaidTierKey,
  type PlanPrice,
} from "@/lib/billing/plans";
import { firstRenewal } from "@/lib/billing/renewal-terms";
import { annualSavingsPercentRange } from "@/lib/marketing-facts";

type CheckoutBody =
  | { kind: "tier"; tier: string; cadence: BillingCadence; source?: CheckoutSource; releaseScheduledChange?: boolean }
  | { kind: "topup"; credits: number; source?: CheckoutSource };

interface ActionResponse {
  url?: string;
  via?: "checkout" | "portal";
  notice?: string;
  error?: string;
  ok?: boolean;
  /** The button that confirms a scheduled_change_pending answer. */
  confirmLabel?: string;
}

async function postJson(path: string, body?: unknown): Promise<ActionResponse> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
  });
  try {
    return (await response.json()) as ActionResponse;
  } catch {
    return { error: `Request failed with status ${response.status}.` };
  }
}

function Notice({ children, tone = "amber" }: { children: React.ReactNode; tone?: "amber" | "green" }) {
  return (
    <p
      className={cn("mt-2 text-xs", tone === "green" ? "text-emerald-700" : "text-amber-700")}
      data-testid="billing-notice"
      role="status"
    >
      {children}
    </p>
  );
}

export function CheckoutButton({
  label,
  body,
  variant = "primary",
}: {
  label: string;
  body: CheckoutBody;
  variant?: "primary" | "secondary" | "outline";
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ notice: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function go(releaseScheduledChange = false) {
    setBusy(true);
    setNotice(null);
    setConfirm(null);
    try {
      const data = await postJson(
        "/api/billing/checkout",
        releaseScheduledChange && body.kind === "tier" ? { ...body, releaseScheduledChange: true } : body,
      );
      if (data.error === "scheduled_change_pending" && data.notice) {
        // P20-06 stopgap: the upgrade would cancel a change the founder
        // scheduled; nothing is released until the subscriber continues.
        setConfirm({ notice: data.notice, label: data.confirmLabel ?? "Continue" });
        return;
      }
      if (data.url) {
        trackBillingEvent("checkout_started", {
          kind: body.kind,
          tier: body.kind === "tier" ? body.tier : null,
          cadence: body.kind === "tier" ? body.cadence : null,
          credits: body.kind === "topup" ? body.credits : null,
          via: data.via ?? "checkout",
          source: body.source ?? "billing",
        });
        window.location.assign(data.url);
        return;
      }
      setNotice(data.notice ?? data.error ?? "Checkout is not available right now.");
    } catch {
      setNotice("Checkout is not available right now.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Button variant={variant} className="w-full" disabled={busy} onClick={() => void go()}>
        {busy ? "Opening" : label}
      </Button>
      {notice ? <Notice>{notice}</Notice> : null}
      {confirm ? (
        <div className="mt-2" data-testid="scheduled-change-confirm">
          <Notice>{confirm.notice}</Notice>
          <Button variant="outline" className="mt-2 w-full" disabled={busy} onClick={() => void go(true)}>
            {confirm.label}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function PortalButton({
  label = "Open customer portal",
  variant = "outline",
}: {
  label?: string;
  variant?: "primary" | "secondary" | "outline";
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    setNotice(null);
    try {
      const data = await postJson("/api/billing/portal");
      if (data.url) {
        trackBillingEvent("portal_opened", {});
        window.location.assign(data.url);
        return;
      }
      setNotice(data.notice ?? data.error ?? "The portal is not available right now.");
    } catch {
      setNotice("The portal is not available right now.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Button variant={variant} disabled={busy} onClick={() => void go()}>
        {busy ? "Opening" : label}
      </Button>
      {notice ? <Notice>{notice}</Notice> : null}
    </div>
  );
}

/** Shown in place of checkout while card payments are not open. */
export function RequestPlanButton({
  label,
  body,
  variant = "primary",
}: {
  label: string;
  body: { kind: "tier"; tier: string; cadence: BillingCadence } | { kind: "topup"; credits: number };
  variant?: "primary" | "secondary" | "outline";
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    setNotice(null);
    try {
      const data = await postJson("/api/billing/upgrade-request", body);
      if (data.ok) {
        setSaved(true);
        trackBillingEvent("upgrade_requested", body);
      }
      setNotice(data.notice ?? data.error ?? "Could not save the request. Email hello@curvi.ai instead.");
    } catch {
      setNotice("Could not save the request. Email hello@curvi.ai instead.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Button variant={variant} className="w-full" disabled={busy || saved} onClick={() => void go()}>
        {saved ? "Request saved" : busy ? "Saving" : label}
      </Button>
      {notice ? <Notice tone={saved ? "green" : "amber"}>{notice}</Notice> : null}
    </div>
  );
}

export type PlanActionMode = "checkout" | "request" | "none";

export function CadenceToggle({
  cadence,
  onChange,
}: {
  cadence: BillingCadence;
  onChange: (cadence: BillingCadence) => void;
}) {
  const annual = cadence === "annual";
  return (
    <div className="flex items-center gap-3">
      <span className={cn("text-sm font-medium", annual ? "text-ink-400" : "text-ink-900")}>Monthly</span>
      <button
        type="button"
        role="switch"
        aria-checked={annual}
        aria-label="Bill annually"
        data-testid="cadence-toggle"
        onClick={() => onChange(annual ? "monthly" : "annual")}
        className={cn("relative h-6 w-11 rounded-full transition-colors", annual ? "bg-accent-500" : "bg-ink-200")}
      >
        <span
          className={cn(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
            annual ? "left-[22px]" : "left-0.5",
          )}
        />
      </button>
      <span className={cn("text-sm font-medium", annual ? "text-ink-900" : "text-ink-400")}>
        Annual, save up to {annualSavingsPercentRange().max} percent
      </span>
    </div>
  );
}

/** What a plan card lists: only what runs today (P20-08). Lines that do
 * not run yet are in the OnTheWay list under the cards. */
export function PlanFeatureList({ tier }: { tier: PaidTierKey }) {
  const included = includedFeatures(tier);
  return (
    <div className="flex-1">
      <ul className="mt-3 space-y-1 text-sm text-ink-600" data-testid={`plan-lines-${tier}`}>
        {included.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The plan cards sold online (P20-08: Agency is set up by email) with a
 * monthly and annual toggle, and the On the way list under them. mode picks
 * the action:
 * checkout (Stripe is live), request (card payments not open yet) or none
 * (the viewer cannot change billing).
 *
 * For a subscriber the toggle starts on their own cadence, and each card
 * follows planChangeDirection (P20-06 stopgap): an upgrade opens the portal
 * with the renewal terms beside the button, the current price opens the
 * portal home, and anything else (a smaller plan, or a monthly price for a
 * yearly subscriber) shows the email line instead of a button.
 */
export function PlanPicker({
  currentPlan,
  hasSubscription,
  currentCadence = null,
  mode,
  initialCadence,
  today,
}: {
  currentPlan: string;
  hasSubscription: boolean;
  /** The subscription's cadence, when known (subscriptions.cadence). */
  currentCadence?: BillingCadence | null;
  mode: PlanActionMode;
  initialCadence?: BillingCadence;
  /** The server's date (ISO), which dates the cancel deadline in the
   * renewal terms beside each buy button (P20-07). */
  today?: string;
}) {
  const from: PlanPrice | null =
    hasSubscription && isPaidTierKey(currentPlan) ? { tier: currentPlan, cadence: currentCadence ?? "monthly" } : null;
  const [cadence, setCadence] = useState<BillingCadence>(initialCadence ?? from?.cadence ?? "monthly");
  const start = today ? new Date(today) : null;

  return (
    <div>
      <CadenceToggle cadence={cadence} onChange={setCadence} />
      <div className="mt-6 grid gap-6 md:grid-cols-3">
        {selfServeTiers.map((tier) => {
          const key = tier.key as PaidTierKey;
          const current = from !== null && tier.key === from.tier;
          const price = priceForCadence(tier, cadence);
          const name = tierDisplayName(tier.key);
          const target: PlanPrice = { tier: key, cadence };
          const direction = from ? planChangeDirection(from, target) : null;
          const byEmail = mode === "checkout" && direction === "downgrade";
          const label =
            direction === null
              ? `Choose ${name}`
              : direction === "same"
                ? "Manage plan"
                : current
                  ? "Switch to yearly billing"
                  : `Switch to ${name}`;
          return (
            <Card key={tier.key} className={cn("flex flex-col", current && "border-accent-500 shadow-md")}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>{name}</CardTitle>
                  {current ? <Badge variant="success">Current plan</Badge> : null}
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col">
                <p className="flex items-baseline gap-1">
                  <span data-testid={`billing-price-${tier.key}`} className="text-3xl font-bold tracking-tight text-ink-950">
                    {formatUsd(price.perMonthUsd)}
                  </span>
                  <span className="text-sm text-ink-500">per month</span>
                </p>
                <p className="mt-1 text-xs text-ink-500">
                  {cadence === "annual"
                    ? `Billed ${formatUsd(price.billedUsd)} once a year. Save ${formatUsd(annualSavingsUsd(tier))} a year.`
                    : "Billed monthly."}
                </p>
                <p className="mt-2 text-sm font-medium text-ink-700">
                  {cadence === "annual"
                    ? `${formatCredits(price.creditsPerInvoice)} added up front each year`
                    : `${formatCredits(tier.creditsPerMonth)} each month`}
                </p>
                <PlanFeatureList tier={key} />
                <div className="mt-5">
                  {byEmail ? (
                    <ScheduledPlanButton label={`Switch to ${name} at renewal`} target={target} />
                  ) : mode === "checkout" ? (
                    <CheckoutButton
                      label={label}
                      body={{ kind: "tier", tier: key, cadence, source: "billing" }}
                      variant={direction === "same" ? "outline" : "primary"}
                    />
                  ) : mode === "request" ? (
                    <RequestPlanButton
                      label={`Request ${name}`}
                      body={{ kind: "tier", tier: key, cadence }}
                      variant="outline"
                    />
                  ) : null}
                  {mode !== "none" && direction !== "same" ? (
                    <RenewalTerms
                      tier={key}
                      cadence={cadence}
                      renewsOn={start && !hasSubscription ? firstRenewal(start, cadence) : null}
                    />
                  ) : null}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <OnTheWay className="mt-6" />
    </div>
  );
}

const POLL_INTERVAL_MS = 3000;
const POLL_LIMIT_MS = 30000;

/**
 * Confirmation after returning from Stripe (Update.md 6.13). On success it
 * refreshes the page every few seconds for up to 30 seconds, until the server
 * confirms the purchase landed (or, when it cannot tell, until the plan or
 * the balance changes), because the webhook arrives asynchronously.
 */
export function CheckoutReturnNotice({
  status,
  kind,
  plan,
  creditBalance,
  confirmed,
}: {
  status: CheckoutStatus;
  kind: string | null;
  plan: string;
  creditBalance: number;
  /** Server check that the webhook applied this purchase; null when unknown. */
  confirmed: boolean | null;
}) {
  const router = useRouter();
  const initial = useRef({ plan, creditBalance });
  const [timedOut, setTimedOut] = useState(false);
  const changed = plan !== initial.current.plan || creditBalance !== initial.current.creditBalance;
  const updated = confirmed ?? changed;

  useEffect(() => {
    trackBillingEvent("checkout_returned", { status, kind });
  }, [status, kind]);

  useEffect(() => {
    if (status !== "success" || updated) {
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started >= POLL_LIMIT_MS) {
        window.clearInterval(timer);
        setTimedOut(true);
        return;
      }
      router.refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [status, updated, router]);

  if (status === "canceled") {
    return (
      <div className="rounded-xl border border-ink-100 bg-ink-50 p-4 text-sm text-ink-700" role="status" data-testid="checkout-return">
        Checkout was canceled. You were not charged.
      </div>
    );
  }

  let message: string;
  if (updated) {
    message = "All set. Your plan and credits are up to date.";
  } else if (timedOut) {
    message =
      kind === "plan_change"
        ? "Your plan change is saved. If this page still shows the old plan in a few minutes, email hello@curvi.ai."
        : "Your payment went through, but this page has not caught up yet. Refresh in a few minutes, or email hello@curvi.ai if nothing changes.";
  } else if (kind === "topup") {
    message = "Payment received. Your credits arrive within a minute.";
  } else if (kind === "plan_change") {
    message = "Plan change confirmed. This page updates within a minute.";
  } else {
    message = "Payment received. Your plan and credits update within a minute.";
  }

  return (
    <div
      className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
      role="status"
      data-testid="checkout-return"
    >
      {message}
    </div>
  );
}

export function CadenceSwitchLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="text-sm font-medium text-accent-700 underline underline-offset-2 hover:text-accent-800">
      {label}
    </Link>
  );
}

/**
 * The past due notice every app page shows while a renewal payment is
 * failing (money-dunning). /app/billing shows its own fuller notice with the
 * Update card button, so this one stays out of the way there.
 */
export function PastDueBanner({ message }: { message: string }) {
  const pathname = usePathname();
  if (pathname?.startsWith("/app/billing")) {
    return null;
  }
  return (
    <div className="border-b border-red-200 bg-red-50" role="alert" data-testid="app-past-due-banner">
      <p className="mx-auto flex max-w-6xl flex-wrap items-baseline gap-x-2 gap-y-1 px-6 py-2 text-sm text-red-900">
        <span className="font-semibold">Your last payment did not go through.</span>
        <span className="text-red-800">{message}</span>
        <Link href="/app/billing" className="font-medium underline underline-offset-2 hover:text-red-950">
          Open Billing
        </Link>
      </p>
    </div>
  );
}
