"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, cn } from "@curvi/ui";
import { creditCosts, tierByKey, topUps } from "@curvi/pipeline/seed";
import { trackBillingEvent } from "@/lib/billing/analytics";
import { billingCheckoutHref, signupHref } from "@/lib/billing/intent";
import { COMING_SOON_LABEL, comingSoonFeatures, includedFeatures } from "@/lib/billing/plan-features";
import {
  annualSavingsUsd,
  formatCredits,
  formatUsd,
  maxAnnualSavingsPct,
  paidTiers,
  priceForCadence,
  tierDisplayName,
  type BillingCadence,
  type PaidTierKey,
} from "@/lib/billing/plans";
import { packsPerMonth, stillPackCredits } from "@/lib/billing/pricing-copy";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// Prices, credit amounts and savings come from the seed (CLAUDE.md rule 2);
// only the marketing wording lives here and in lib/billing/plan-features.
const TIER_BLURBS: Record<PaidTierKey, string> = {
  starter: "For one store getting its catalog compliant.",
  growth: "For brands refreshing listings every month.",
  pro: "For larger catalogs with many products.",
  agency: "For agencies running client stores.",
};

const freeTier = tierByKey("free");

function creditsLabel(cost: number): string {
  return cost === 1 ? "1 credit" : `${cost} credits`;
}

const creditTable: { asset: string; cost: string; comingSoon?: boolean }[] = [
  { asset: "Deterministic asset: white main, cutout, resize or sweep", cost: creditsLabel(creditCosts.deterministic) },
  { asset: "One generative still at up to 2K", cost: creditsLabel(creditCosts.generativeStill) },
  { asset: "A 4K or Pro model still", cost: creditsLabel(creditCosts.pro4kStill), comingSoon: true },
  { asset: "A templated video", cost: creditsLabel(creditCosts.templatedVideo), comingSoon: true },
  {
    asset: "Generative video, Lite",
    cost: `${creditsLabel(creditCosts.generativeVideoPerSecondLite)} per second`,
    comingSoon: true,
  },
  {
    asset: "Generative video, premium",
    cost: `${creditsLabel(creditCosts.generativeVideoPerSecondPremium)} per second`,
    comingSoon: true,
  },
  { asset: "A UGC avatar ad", cost: creditsLabel(creditCosts.ugcAvatarAd), comingSoon: true },
];

function freePacksLabel(credits: number, packCredits: number): string {
  const packs = Math.floor(credits / packCredits);
  if (packs < 1) {
    return "Enough to try a few still images with a compliance report.";
  }
  return packs === 1
    ? "That covers about 1 product pack with a compliance report."
    : `That covers about ${packs} product packs with a compliance report.`;
}

function ComingSoonChip() {
  return (
    <span className="ml-2 inline-flex items-center rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-600">
      {COMING_SOON_LABEL}
    </span>
  );
}

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

export function PricingTiers() {
  const [cadence, setCadence] = useState<BillingCadence>("monthly");
  const signedIn = useSignedIn();
  const annual = cadence === "annual";
  const packCredits = stillPackCredits();

  function ctaHref(tier: PaidTierKey): string {
    return signedIn
      ? billingCheckoutHref({ tier, cadence })
      : signupHref({ plan: tier, cadence, source: "pricing" });
  }

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
          Annual, save up to {maxAnnualSavingsPct()} percent
        </span>
      </div>

      <div className="mt-8 grid gap-6 md:grid-cols-2 xl:grid-cols-4">
        {paidTiers.map((seedTier) => {
          const key = seedTier.key as PaidTierKey;
          const name = tierDisplayName(key);
          const price = priceForCadence(seedTier, cadence);
          const included = includedFeatures(key);
          const comingSoon = comingSoonFeatures(key);
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
                <p className="mt-1 text-xs text-ink-500">
                  About {packsPerMonth(seedTier.creditsPerMonth).toLocaleString("en-US")} product packs a month
                </p>
                <ul className="mt-4 space-y-2">
                  {included.map((item) => (
                    <li key={item} className="flex gap-2 text-sm text-ink-600">
                      <CheckIcon />
                      {item}
                    </li>
                  ))}
                </ul>
                {comingSoon.length > 0 ? (
                  <div className="mt-4 flex-1">
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">{COMING_SOON_LABEL}</p>
                    <ul className="mt-2 space-y-1" data-testid={`coming-soon-${key}`}>
                      {comingSoon.map((item) => (
                        <li key={item} className="text-sm text-ink-400">
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="flex-1" />
                )}
                <Link
                  href={ctaHref(key)}
                  onClick={() => trackBillingEvent("pricing_cta_clicked", { tier: key, cadence, signedIn })}
                  data-testid={`cta-${key}`}
                  className="mt-6 inline-flex h-10 items-center justify-center rounded-lg bg-ink-900 px-4 text-sm font-medium text-white transition-colors hover:bg-ink-800"
                >
                  Start with {name}
                </Link>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="mx-auto mt-8 flex max-w-4xl flex-col items-start justify-between gap-4 rounded-xl border border-ink-100 p-6 sm:flex-row sm:items-center">
        <div>
          <p className="text-sm font-semibold text-ink-900">Free</p>
          <p className="mt-1 text-sm text-ink-600">
            {formatCredits(freeTier.creditsOnce)} once, no card needed. {freePacksLabel(freeTier.creditsOnce, packCredits)}
          </p>
        </div>
        <Link
          href={signedIn ? "/app" : signupHref({ source: "pricing" })}
          onClick={() => trackBillingEvent("pricing_cta_clicked", { tier: "free", cadence: null, signedIn })}
          data-testid="cta-free"
          className="inline-flex h-10 shrink-0 items-center justify-center rounded-lg border border-ink-200 px-4 text-sm font-medium text-ink-900 transition-colors hover:bg-ink-50"
        >
          Start free
        </Link>
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
                      {row.comingSoon ? <ComingSoonChip /> : null}
                    </td>
                    <td className="px-4 py-3 font-medium text-ink-900">{row.cost}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-sm text-ink-500">
            A product pack of still images sized for Amazon and Shopify uses about {creditsLabel(packCredits)}.
          </p>
        </div>
        <div>
          <h2 className="text-xl font-semibold text-ink-950">Top ups and rollover</h2>
          <ul className="mt-4 space-y-3 text-sm text-ink-700">
            <li className="rounded-lg border border-ink-100 p-4">
              {topUps.map((t) => `${formatCredits(t.credits)} for ${formatUsd(t.usd)}.`).join(" ")} Top up credits last{" "}
              {topUps[0]?.expiresMonths ?? 12} months and work on any plan, including Free.{" "}
              <Link
                href={signedIn ? "/app/billing#top-ups" : signupHref({ source: "pricing" })}
                className="font-medium text-accent-700 underline underline-offset-2 hover:text-accent-800"
              >
                Buy credits
              </Link>
            </li>
            <li className="rounded-lg border border-ink-100 p-4">
              Unused subscription credits roll over for one cycle, capped at one month of your allowance.
            </li>
            <li className="rounded-lg border border-ink-100 p-4">
              Annual plans add the whole year of credits when the annual invoice is paid.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
