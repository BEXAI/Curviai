import type { Metadata } from "next";
import { tierByKey } from "@curvi/pipeline/seed";
import { PricingTiers } from "@/components/marketing/pricing-tiers";

export const metadata: Metadata = {
  title: "Pricing",
  description: `Credit subscriptions from $${tierByKey("starter").monthlyUsd} per month. Every plan includes compliant main images, lifestyle scenes and channel sized exports.`,
};

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-16">
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
