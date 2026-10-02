"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, cn } from "@curvi/ui";
import { creditCosts, topUps } from "@curvi/pipeline/seed";
import { ComingSoonBadge } from "@/components/marketing/coming-soon-badge";
import { trackBillingEvent } from "@/lib/billing/analytics";
import { billingCheckoutHref } from "@/lib/billing/intent";
import { includedFeatures } from "@/lib/billing/plan-features";
import {
  annualSavingsUsd,
  formatCredits,
  formatUsd,
  priceForCadence,
  selfServeTiers,
  tierDisplayName,
  type BillingCadence,
  type PaidTierKey,
} from "@/lib/billing/plans";
import {
  annualSavingsPercentRange,
  FEATURES,
  formatCredits as creditCost,
  freeCredits,
  freeCreditsReach,
  packsForCredits,
  typicalPackCredits,
  CREDIT_TERMS_SENTENCE,
  type Availability,
} from "@/lib/marketing-facts";
import { perPackUsd } from "@/lib/offer/per-pack";
import { TAX_LINE } from "@/lib/billing/renewal-terms";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { AcquisitionCta } from "./acquisition-cta";
import { OnTheWay } from "./on-the-way";
import { perPackLine } from "./offer-copy";
import { RenewalTerms } from "./renewal-terms";
import { SignupLink } from "./signup-link";

// Prices, credit amounts and savings come from the seed (CLAUDE.md rule 2),
// and pack sizes, savings and feature availability come from the same
// helpers the rest of the site uses (lib/marketing-facts), so /pricing never
// disagrees with the home page, help or the app. Only wording lives here.
const TIER_BLURBS: Record<PaidTierKey, string> = {
  starter: "For one store getting its catalog compliant.",
  growth: "For brands refreshing listings every month.",
  pro: "For larger catalogs with many products.",
  agency: "For agencies running client stores.",
};

const creditTable: { asset: string; cost: string; status: Availability }[] = [
  {
    asset: "Deterministic asset: white main, cutout, resize or sweep",
    cost: creditCost(creditCosts.deterministic),
    status: FEATURES.whiteMainImage.status,
  },
  {
    asset: "One generative still at up to 2K",
    cost: creditCost(creditCosts.generativeStill),
    status: FEATURES.lifestyleScenes.status,
  },
  // No pack renders 4K or Pro model stills yet, and no feature flag covers them.
  { asset: "A 4K or Pro model still", cost: creditCost(creditCosts.pro4kStill), status: "coming_soon" },
  { asset: "A templated video", cost: creditCost(creditCosts.templatedVideo), status: FEATURES.video.status },
  {
    asset: "Generative video, Lite",
    cost: `${creditCost(creditCosts.generativeVideoPerSecondLite)} per second`,
    status: FEATURES.video.status,
  },
  {
    asset: "Generative video, premium",
    cost: `${creditCost(creditCosts.generativeVideoPerSecondPremium)} per second`,
    status: FEATURES.video.status,
  },
  { asset: "A UGC avatar ad", cost: creditCost(creditCosts.ugcAvatarAd), status: FEATURES.ugcAds.status },
];

function CheckIcon() {
  return (
    <svg className="mt-0.5 h-4 w-4 shrink-0 text-accent-500" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** True once the browser holds a Supabase session. Reading the local session
 * needs no network call and keeps the pricing page static. */
function useSignedIn(): boolean {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    if (!supabase) {
      return;
    }
    let active = true;
    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (active) {
          setSignedIn(Boolean(data.session));
        }
      })
      .catch(() => {
        // Treat an unreadable session as signed out; signup still works.
      });
    return () => {
      active = false;
    };
  }, []);
  return signedIn;
}

const PLAN_CTA_CLASS =
  "mt-6 inline-flex h-10 items-center justify-center rounded-lg bg-ink-900 px-4 text-sm font-medium text-white transition-colors hover:bg-ink-800";
const FREE_CTA_CLASS =
  "inline-flex h-10 shrink-0 items-center justify-center rounded-lg border border-ink-200 px-4 text-sm font-medium text-ink-900 transition-colors hover:bg-ink-50";
const TOP_UP_LINK_CLASS = "font-medium text-accent-700 underline underline-offset-2 hover:text-accent-800";

/**
 * The /pricing calls to action (P18-01, P18-03). Signed out, every one is
 * the shared SignupLink with source pricing: it carries the page's landing
 * parameters and, while packs are paused, turns into the waitlist button. A
 * signed in plan button goes to checkout, so it sits in AcquisitionCta and
 * never opens Stripe Checkout while packs cannot run. The renewal terms sit
 * beside every plan button (P20-07), and lines that do not run yet are in
 * the On the way list under the cards (P20-08).
 */
export function PricingTiers({ showTaxLine = false }: { showTaxLine?: boolean } = {}) {
  const [cadence, setCadence] = useState<BillingCadence>("monthly");
  const signedIn = useSignedIn();
  const annual = cadence === "annual";

  return (
    <div>
      <div className="flex items-center justify-center gap-3">
        <span className={cn("text-sm font-medium", annual ? "text-ink-400" : "text-ink-900")}>Monthly</span>
        <button
          type="button"
          role="switch"
          aria-checked={annual}
          aria-label="Toggle annual billing"
          onClick={() => setCadence(annual ? "monthly" : "annual")}
          className={cn("relative h-6 w-11 rounded-full transition-colors", annual ? "bg-accent-500" : "bg-ink-200")}
        >
          <span
            className={cn(
              "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
              annual ? "left-[22px]" : "left-0.5",
            )}
          />
        </button>
        <span className={cn("text-sm font-medium", annual ? "text-ink-900" : "text-ink-400")} data-testid="annual-savings">
          Annual, save up to {annualSavingsPercentRange().max} percent
        </span>
      </div>

      <div className="mt-8 grid gap-6 md:grid-cols-3">
        {selfServeTiers.map((seedTier) => {
          const key = seedTier.key as PaidTierKey;
          const name = tierDisplayName(key);
          const price = priceForCadence(seedTier, cadence);
          const included = includedFeatures(key);
          const perPack = perPackUsd(price.perMonthUsd, seedTier.creditsPerMonth);
          return (
            <Card key={key} className="flex flex-col" data-testid={`tier-${key}`}>
              <CardHeader>
                <CardTitle>{name}</CardTitle>
                <p className="text-sm text-ink-500">{TIER_BLURBS[key]}</p>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col">
                <p className="flex items-baseline gap-1">
                  <span data-testid={`price-${key}`} className="text-4xl font-bold tracking-tight text-ink-950">
                    {formatUsd(price.perMonthUsd)}
                  </span>
                  <span className="text-sm text-ink-500">per month{annual ? ", billed annually" : ""}</span>
                </p>
                {annual ? (
                  <p className="mt-1 text-xs text-ink-500">
                    {formatUsd(price.billedUsd)} a year. Save {formatUsd(annualSavingsUsd(seedTier))} a year.
                  </p>
                ) : null}
                <p className="mt-2 text-sm font-medium text-ink-700">
                  {formatCredits(seedTier.creditsPerMonth)} per month
                  {annual ? `, all ${price.creditsPerInvoice.toLocaleString("en-US")} added up front` : ""}
                </p>
                <p className="mt-1 text-xs text-ink-500" data-testid={`packs-${key}`}>
                  About {packsForCredits(seedTier.creditsPerMonth).toLocaleString("en-US")} listing packs a month
                </p>
                {perPack !== null ? (
                  <p className="mt-1 text-xs font-medium text-ink-700" data-testid={`per-pack-${key}`}>
                    {perPackLine(perPack)}
                  </p>
                ) : null}
                <ul className="mt-4 space-y-2">
                  {included.map((item) => (
                    <li key={item} className="flex gap-2 text-sm text-ink-600">
                      <CheckIcon />
                      {item}
                    </li>
                  ))}
                </ul>
                <div className="flex-1" />
                {signedIn ? (
                  <AcquisitionCta className={PLAN_CTA_CLASS}>
                    <Link
                      href={billingCheckoutHref({ tier: key, cadence })}
                      onClick={() => trackBillingEvent("pricing_cta_clicked", { tier: key, cadence, signedIn })}
                      data-testid={`cta-${key}`}
                      className={PLAN_CTA_CLASS}
                    >
                      Start with {name}
                    </Link>
                  </AcquisitionCta>
                ) : (
                  <SignupLink
                    plan={key}
                    cadence={cadence}
                    source="pricing"
                    onClick={() => trackBillingEvent("pricing_cta_clicked", { tier: key, cadence, signedIn })}
                    data-testid={`cta-${key}`}
                    className={PLAN_CTA_CLASS}
                  >
                    Start with {name}
                  </SignupLink>
                )}
                <RenewalTerms tier={key} cadence={cadence} />
              </CardContent>
            </Card>
          );
        })}
      </div>

      {showTaxLine ? (
        <p className="mt-4 text-center text-sm text-ink-500" data-testid="tax-line">
          {TAX_LINE}
        </p>
      ) : null}

      <OnTheWay className="mt-8" />

      <div className="mx-auto mt-8 flex max-w-4xl flex-col items-start justify-between gap-4 rounded-xl border border-ink-100 p-6 sm:flex-row sm:items-center">
        <div>
          <p className="text-sm font-semibold text-ink-900">Free</p>
          <p className="mt-1 text-sm text-ink-600" data-testid="free-credits">
            {formatCredits(freeCredits())} once, no card needed, {freeCreditsReach()}.
          </p>
        </div>
        {signedIn ? (
          <Link
            href="/app"
            onClick={() => trackBillingEvent("pricing_cta_clicked", { tier: "free", cadence: null, signedIn })}
            data-testid="cta-free"
            className={FREE_CTA_CLASS}
          >
            Start free
          </Link>
        ) : (
          <SignupLink
            source="pricing"
            onClick={() => trackBillingEvent("pricing_cta_clicked", { tier: "free", cadence: null, signedIn })}
            data-testid="cta-free"
            className={FREE_CTA_CLASS}
          >
            Start free
          </SignupLink>
        )}
      </div>

      <div className="mt-16 grid gap-10 lg:grid-cols-2">
        <div>
          <h2 className="text-xl font-semibold text-ink-950">What a credit buys</h2>
          <div className="mt-4 overflow-x-auto rounded-xl border border-ink-100">
            <table className="w-full min-w-[26rem] text-left text-sm">
              <thead className="bg-ink-50 text-ink-700">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Asset
                  </th>
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {creditTable.map((row) => (
                  <tr key={row.asset} className="border-t border-ink-100">
                    <td className="px-4 py-3 text-ink-700">
                      {row.asset}
                      {row.status === "coming_soon" ? <ComingSoonBadge className="ml-2" /> : null}
                    </td>
                    <td className="px-4 py-3 font-medium text-ink-900">{row.cost}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-sm text-ink-500" data-testid="pricing-pack-size">
            A typical listing pack of still images uses about {typicalPackCredits()} credits. You are only charged for
            files that pass their checks.
          </p>
        </div>
        <div>
          <h2 className="text-xl font-semibold text-ink-950">Top ups and unused credits</h2>
          <ul className="mt-4 space-y-3 text-sm text-ink-700" data-testid="credit-terms">
            <li className="rounded-lg border border-ink-100 p-4">
              {topUps.map((t) => `${formatCredits(t.credits)} for ${formatUsd(t.usd)}.`).join(" ")} Top up credits
              work on any plan, including Free.{" "}
              {signedIn ? (
                <Link href="/app/billing#top-ups" className={TOP_UP_LINK_CLASS}>
                  Buy credits
                </Link>
              ) : (
                <SignupLink source="pricing" className={TOP_UP_LINK_CLASS}>
                  Buy credits
                </SignupLink>
              )}
            </li>
            <li className="rounded-lg border border-ink-100 p-4">{CREDIT_TERMS_SENTENCE}</li>
            <li className="rounded-lg border border-ink-100 p-4">
              Annual plans add the whole year of credits when the annual invoice is paid.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
