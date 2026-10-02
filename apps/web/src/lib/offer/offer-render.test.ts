import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { studioPriceComparison } from "@curvi/pipeline/seed";
import { priceForCadence, selfServeTiers } from "@/lib/billing/plans";
import { formatPerPackUsd, formatSeedDate, perPackUsd } from "./per-pack";

// /pricing (P18-21): each paid plan states its per pack price from the seed,
// the studio comparison is dated, and the founding banner renders nothing
// on the server (it appears only once GET /api/offer says it is live).

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

const { PricingTiers } = await import("@/components/marketing/pricing-tiers");
const { default: PricingPage } = await import("@/app/(marketing)/pricing/page");

function textOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("/pricing offer framing", () => {
  it("shows the monthly per pack price on every paid plan card", () => {
    const html = renderToStaticMarkup(React.createElement(PricingTiers));
    // The cards show the plans sold online (P20-08: Agency is by email).
    for (const tier of selfServeTiers) {
      const usd = perPackUsd(priceForCadence(tier, "monthly").perMonthUsd, tier.creditsPerMonth);
      expect(usd, tier.key).not.toBeNull();
      expect(html).toMatch(
        new RegExp(`data-testid="per-pack-${tier.key}"[^>]*>About \\${formatPerPackUsd(usd as number)} per listing pack\\.<`),
      );
    }
  });

  it("dates the studio comparison and renders no banner on the server", () => {
    const html = renderToStaticMarkup(PricingPage());
    expect(textOf(html)).toContain(
      `a product photo studio, listed $${studioPriceComparison.usdPerPhoto} per photo on ${formatSeedDate(studioPriceComparison.checkedOn)}.`,
    );
    expect(html).not.toContain("founding-offer-banner");
  });
});
