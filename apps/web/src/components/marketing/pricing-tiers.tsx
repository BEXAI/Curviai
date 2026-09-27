"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge, Card, CardContent, CardHeader, CardTitle, cn } from "@curvi/ui";

interface Tier {
  id: string;
  name: string;
  monthly: number;
  annualPerMonth: number;
  credits: number;
  blurb: string;
  includes: string[];
  highlighted?: boolean;
}

const tiers: Tier[] = [
  {
    id: "starter",
    name: "Starter",
    monthly: 29,
    annualPerMonth: 24,
    credits: 200,
    blurb: "For one store getting its catalog compliant.",
    includes: ["1 brand kit", "All image assets", "Templated video", "Compliance report on every file"],
  },
  {
    id: "growth",
    name: "Growth",
    monthly: 79,
    annualPerMonth: 66,
    credits: 600,
    blurb: "For brands shipping fresh creative every week.",
    includes: [
      "Everything in Starter",
      "Generative video",
      "Fresh Creative Drop every Monday",
      "Shopify auto packs for new products",
    ],
    highlighted: true,
  },
  {
    id: "pro",
    name: "Pro",
    monthly: 149,
    annualPerMonth: 124,
    credits: 1300,
    blurb: "For larger catalogs and paid social at volume.",
    includes: ["Everything in Growth", "UGC hook ads", "3 brand kits", "Priority queue"],
  },
  {
    id: "agency",
    name: "Agency",
    monthly: 349,
    annualPerMonth: 290,
    credits: 3500,
    blurb: "For agencies running client stores.",
    includes: [
      "Everything in Pro",
      "10 client workspaces",
      "Client review links",
      "White label share pages",
    ],
  },
];

const creditTable: { asset: string; cost: string }[] = [
  { asset: "Deterministic asset: white main, cutout, resize or sweep", cost: "0.5 credit" },
  { asset: "One generative still at up to 2K", cost: "1 credit" },
  { asset: "A 4K or Pro model still", cost: "3 credits" },
  { asset: "A templated video", cost: "2 credits" },
  { asset: "Generative video, Lite", cost: "1 credit per second" },
  { asset: "Generative video, premium", cost: "3 credits per second" },
  { asset: "A UGC avatar ad", cost: "30 credits" },
];

export function PricingTiers() {
  const [annual, setAnnual] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-center gap-3">
        <span className={cn("text-sm font-medium", annual ? "text-ink-400" : "text-ink-900")}>Monthly</span>
        <button
          type="button"
          role="switch"
          aria-checked={annual}
          aria-label="Toggle annual billing"
          onClick={() => setAnnual((value) => !value)}
          className={cn(
            "relative h-6 w-11 rounded-full transition-colors",
            annual ? "bg-accent-500" : "bg-ink-200",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
              annual ? "left-[22px]" : "left-0.5",
            )}
          />
        </button>
        <span className={cn("text-sm font-medium", annual ? "text-ink-900" : "text-ink-400")}>
          Annual, about 17 percent off
        </span>
      </div>

      <div className="mt-8 grid gap-6 md:grid-cols-2 xl:grid-cols-4">
        {tiers.map((tier) => (
          <Card
            key={tier.id}
            className={cn("flex flex-col", tier.highlighted && "border-accent-500 shadow-md")}
          >
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{tier.name}</CardTitle>
                {tier.highlighted ? <Badge variant="success">Most popular</Badge> : null}
              </div>
              <p className="text-sm text-ink-500">{tier.blurb}</p>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col">
              <p className="flex items-baseline gap-1">
                <span data-testid={`price-${tier.id}`} className="text-4xl font-bold tracking-tight text-ink-950">
                  ${annual ? tier.annualPerMonth : tier.monthly}
                </span>
                <span className="text-sm text-ink-500">per month{annual ? ", billed annually" : ""}</span>
              </p>
              <p className="mt-2 text-sm font-medium text-ink-700">
                {tier.credits.toLocaleString("en-US")} credits per month
              </p>
              <ul className="mt-4 flex-1 space-y-2">
                {tier.includes.map((item) => (
                  <li key={item} className="flex gap-2 text-sm text-ink-600">
                    <svg
                      className="mt-0.5 h-4 w-4 shrink-0 text-accent-500"
                      viewBox="0 0 16 16"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {item}
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className={cn(
                  "mt-6 inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-medium transition-colors",
                  tier.highlighted
                    ? "bg-accent-500 text-white hover:bg-accent-600"
                    : "bg-ink-900 text-white hover:bg-ink-800",
                )}
              >
                Start with {tier.name}
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mx-auto mt-12 max-w-2xl rounded-xl border border-accent-200 bg-accent-50 p-6 text-center">
        <p className="text-sm font-semibold text-ink-900">Founding member pricing</p>
        <p className="mt-1 text-sm text-ink-700">
          The first 50 customers get Starter for $19 per month for life. Hard cap at 50, then it is gone.
        </p>
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
                    <td className="px-4 py-3 text-ink-700">{row.asset}</td>
                    <td className="px-4 py-3 font-medium text-ink-900">{row.cost}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-sm text-ink-500">A default full pack uses about 40 to 60 credits.</p>
        </div>
        <div>
          <h2 className="text-xl font-semibold text-ink-950">Top ups and rollover</h2>
          <ul className="mt-4 space-y-3 text-sm text-ink-700">
            <li className="rounded-lg border border-ink-100 p-4">100 extra credits for $15. 500 extra credits for $60. Top up credits last 12 months.</li>
            <li className="rounded-lg border border-ink-100 p-4">
              Unused subscription credits roll over for one cycle, capped at one month of your allowance.
            </li>
            <li className="rounded-lg border border-ink-100 p-4">
              Free plan: 15 credits once, enough for 1 compliant main image plus 2 lifestyle shots and a share page.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
