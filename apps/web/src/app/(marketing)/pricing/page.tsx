import type { Metadata } from "next";
import { tierByKey } from "@curvi/pipeline/seed";
import { JsonLd } from "@/components/json-ld";
import { PricingTiers } from "@/components/marketing/pricing-tiers";
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
          Every plan buys credits. Credits buy assets. A typical full pack for one product uses about
          40 to 60 credits, so even Starter covers a few products every month.
        </p>
      </div>
      <div className="mt-12">
        <PricingTiers />
      </div>
    </div>
  );
}
