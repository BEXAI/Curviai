/**
 * Per pack price framing (docs/phases/PHASE_18.md P18-21): a paid plan's
 * monthly price over the typical packs its monthly credits cover, both from
 * the seed through lib/marketing-facts. Rounded up to the cent, and the pack
 * count is rounded down, so the price per pack is never understated.
 * Client safe.
 */

import { packsForCredits } from "@/lib/marketing-facts";

/** Dollars per typical listing pack, or null when the plan covers none. */
export function perPackUsd(perMonthUsd: number, creditsPerMonth: number): number | null {
  const packs = packsForCredits(creditsPerMonth);
  if (!(perMonthUsd > 0) || packs <= 0) {
    return null;
  }
  return Math.ceil((perMonthUsd / packs) * 100 - 1e-9) / 100;
}

/** "$1.16". */
export function formatPerPackUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** "October 1, 2026" for a YYYY-MM-DD date, read as a UTC day. */
export function formatSeedDate(isoDay: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  if (!match) {
    return isoDay;
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}
