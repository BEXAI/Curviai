/**
 * Copy for the offer (docs/phases/PHASE_18.md P18-21): the founding member
 * banner, the per pack price line on each paid plan and the dated studio
 * comparison. Every number comes from the seed or the live banner view;
 * only wording lives here (CLAUDE.md rules 2 and 9). offer-copy.test.ts
 * lints every string.
 */

import { foundingMemberOffer, studioPriceComparison } from "@curvi/pipeline/seed";
import type { FoundingOfferView } from "@/lib/offer/founding";
import { formatPerPackUsd, formatSeedDate } from "@/lib/offer/per-pack";

/** "About $1.16 per listing pack." on a paid plan card. */
export function perPackLine(usd: number): string {
  return `About ${formatPerPackUsd(usd)} per listing pack.`;
}

/** The one dated studio price comparison, from the seed. */
export function studioComparisonLine(): string {
  const studio = studioPriceComparison;
  return `For comparison, ${studio.studio}, a product photo studio, listed $${studio.usdPerPhoto} per photo on ${formatSeedDate(studio.checkedOn)}.`;
}

/** "November 30" for the banner's closing day. */
function shortDate(isoDay: string): string {
  return formatSeedDate(isoDay).replace(/, \d{4}$/, "");
}

export interface FoundingBannerText {
  title: string;
  body: string;
  /** Present only while the annual code is active. */
  annual: string | null;
}

/** The banner's words for a live view. */
export function foundingBannerText(view: FoundingOfferView): FoundingBannerText {
  return {
    title: `Founding member price: Starter at $${view.monthlyUsd} a month for as long as you stay.`,
    body: `${view.left} of ${view.seats} seats left, until ${shortDate(view.endsOn)}. Use code ${view.code} at checkout.`,
    annual: view.annualCode ? `Paying yearly? Use code ${view.annualCode} for $${view.annualUsd} a year.` : null,
  };
}

export const FOUNDING_BANNER_DISMISS_LABEL = "Hide the founding member offer";

/** Every string this module can produce for the seed values, for the lint test. */
export function offerCopyTexts(): string[] {
  const sample: FoundingOfferView = {
    code: foundingMemberOffer.code,
    annualCode: foundingMemberOffer.annualCode,
    monthlyUsd: foundingMemberOffer.monthlyUsd,
    annualUsd: foundingMemberOffer.annualUsd,
    seats: foundingMemberOffer.seats,
    left: foundingMemberOffer.seats,
    endsOn: foundingMemberOffer.endsOn,
  };
  const banner = foundingBannerText(sample);
  return [
    perPackLine(1.16),
    studioComparisonLine(),
    banner.title,
    banner.body,
    banner.annual ?? "",
    FOUNDING_BANNER_DISMISS_LABEL,
  ].filter((text) => text.length > 0);
}
