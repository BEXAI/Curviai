import type { Metadata } from "next";
import { tierByKey } from "@curvi/pipeline/seed";
import { JsonLd } from "@/components/json-ld";
import { FoundingOfferBanner } from "@/components/marketing/founding-offer-banner";
import { studioComparisonLine } from "@/components/marketing/offer-copy";
import { PricingTiers } from "@/components/marketing/pricing-tiers";
import { isCheckoutOpen } from "@/lib/env";
import { showTaxLine } from "@/lib/billing/renewal-terms";
import { isStripeTaxEnabled } from "@/lib/billing/stripe";
import { packsForCredits, typicalPackCredits } from "@/lib/marketing-facts";
import { breadcrumbJsonLd, jsonLdGraph, pageMetadata, softwareApplicationJsonLd } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Pricing for AI E-Commerce Product Images",
  description: `AI product images for Shopify and Amazon from $${tierByKey("starter").monthlyUsd} per month. Plans include compliant main images, lifestyle scenes and channel sized exports. Start free.`,
  path: "/pricing",
});

export default function PricingPage() {
  const starter = tierByKey("starter");
  return (
    <div className="mx-auto max-w-6xl px-6 py-16">
      <JsonLd
        data={jsonLdGraph([
          softwareApplicationJsonLd(),
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: "Pricing", path: "/pricing" },
          ]),
        ])}
      />
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-4xl font-bold tracking-tight text-ink-950">Pricing</h1>
        <p className="mt-4 text-lg text-ink-600" data-testid="pricing-intro">
          Every plan buys credits. Credits buy assets. A typical listing pack of still images uses about{" "}
          {typicalPackCredits()} credits, so Starter covers about {packsForCredits(starter.creditsPerMonth)} listing
          packs a month.
        </p>
        <p className="mt-2 text-sm text-ink-500">Prices are in US dollars. Cancel any time from Billing.</p>
        {isCheckoutOpen() ? null : (
          <p className="mt-2 text-sm text-ink-500" data-testid="paid-plans-not-open">
            Paid plans open soon. You can start on the free plan today.
          </p>
        )}
        <p className="mt-2 text-sm text-ink-500" data-testid="studio-comparison">
          {studioComparisonLine()}
        </p>
      </div>
      {/* P18-21: shows only while the founding offer is live (GET /api/offer). */}
      <FoundingOfferBanner className="mt-8" />
      <div className="mt-12">
        <PricingTiers showTaxLine={isCheckoutOpen() && showTaxLine(isStripeTaxEnabled())} />
      </div>
    </div>
  );
}
