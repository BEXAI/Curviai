import type { Metadata } from "next";
import { Badge, Card, CardContent, CardHeader, CardTitle, cn } from "@curvi/ui";
import { tiers, topUps } from "@curvi/pipeline/seed";
import { CheckoutButton, PortalButton } from "@/components/app/billing-actions";
import { getServices } from "@/lib/services";

export const metadata: Metadata = { title: "Billing" };
export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const services = getServices();
  const workspace = await services.getCurrentWorkspace();
  if (!workspace) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-bold text-ink-950">Sign in to manage billing</h1>
      </div>
    );
  }
  const paidTiers = tiers.filter((t) => t.monthlyUsd > 0);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink-950">Billing</h1>
        <p className="mt-1 text-sm text-ink-500">
          You are on the {workspace.plan} plan with {workspace.creditBalance.toLocaleString("en-US")} credits.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
        {paidTiers.map((tier) => {
          const current = tier.key === workspace.plan;
          return (
            <Card key={tier.key} className={cn("flex flex-col", current && "border-accent-500 shadow-md")}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="capitalize">{tier.key}</CardTitle>
                  {current ? <Badge variant="success">Current plan</Badge> : null}
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col">
                <p className="flex items-baseline gap-1">
                  <span className="text-3xl font-bold tracking-tight text-ink-950">${tier.monthlyUsd}</span>
                  <span className="text-sm text-ink-500">per month</span>
                </p>
                <p className="mt-1 text-sm font-medium text-ink-700">
                  {tier.creditsPerMonth.toLocaleString("en-US")} credits per month
                </p>
                <ul className="mt-3 flex-1 space-y-1 text-sm text-ink-600">
                  {tier.includes.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <div className="mt-5">
                  <CheckoutButton
                    label={current ? "Renew plan" : `Switch to ${tier.key}`}
                    body={{ kind: "tier", tier: tier.key, cadence: "monthly" }}
                    variant={current ? "outline" : "primary"}
                  />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <section>
        <h2 className="text-lg font-semibold text-ink-950">Top ups</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:max-w-2xl">
          {topUps.map((topUp) => (
            <Card key={topUp.credits}>
              <CardContent className="p-5">
                <p className="font-medium text-ink-900">
                  {topUp.credits} credits for ${topUp.usd}
                </p>
                <p className="mt-1 text-xs text-ink-400">Lasts {topUp.expiresMonths} months.</p>
                <div className="mt-4">
                  <CheckoutButton
                    label={`Buy ${topUp.credits} credits`}
                    body={{ kind: "topup", credits: topUp.credits }}
                    variant="outline"
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-ink-950">Manage your subscription</h2>
        <p className="mt-1 text-sm text-ink-500">
          Update cards, download invoices or cancel from the customer portal.
        </p>
        <div className="mt-4">
          <PortalButton />
        </div>
      </section>
    </div>
  );
}
