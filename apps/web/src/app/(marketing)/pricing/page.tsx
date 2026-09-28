import type { Metadata } from "next";
import { tierByKey } from "@curvi/pipeline/seed";
import { JsonLd } from "@/components/json-ld";
import { PricingTiers } from "@/components/marketing/pricing-tiers";
import { packsPerMonth, stillPackCredits } from "@/lib/billing/pricing-copy";
import { breadcrumbJsonLd, jsonLdGraph, pageMetadata, softwareApplicationJsonLd } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Pricing for AI E-Commerce Product Images",
  description: `AI product images for Shopify and Amazon from $${tierByKey("starter").monthlyUsd} per month. Plans include compliant main images, lifestyle scenes and channel sized exports. Start free.`,
  path: "/pricing",
});

export default function PricingPage() {
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
        <p className="mt-4 text-lg text-ink-600">
          Every plan buys credits. Credits buy assets. A pack of still images for one product, sized for
          Amazon and Shopify, uses about {stillPackCredits()} credits, so Starter covers about{" "}
          {packsPerMonth(tierByKey("starter").creditsPerMonth)} products a month.
        </p>
        <p className="mt-2 text-sm text-ink-500">Prices are in US dollars. Cancel any time from Billing.</p>
      </div>
      <div className="mt-12">
        <PricingTiers />
      </div>
    </div>
  );
}
