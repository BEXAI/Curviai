/**
 * Maps Stripe price ids to tiers and top ups. Price ids are injected through
 * environment variables by name; credit amounts come from the seed data in
 * @curvi/pipeline/seed. Nothing here hardcodes a price id or a price.
 */

import { tiers, topUps, type TierKey } from "@curvi/pipeline/seed";
import { optionalEnv } from "@/lib/env";
import type { BillingCadence } from "./plans";

export type { BillingCadence } from "./plans";

export type PriceMapping =
  | { kind: "tier"; tier: TierKey; cadence: BillingCadence; creditsPerMonth: number }
  | { kind: "topup"; credits: number; expiresMonths: number };

/** priceId to what it grants. */
export type PriceTable = Record<string, PriceMapping>;

export function tierPriceEnvName(tier: TierKey, cadence: BillingCadence): string {
  return `STRIPE_PRICE_${tier.toUpperCase()}_${cadence.toUpperCase()}`;
}

export function topUpPriceEnvName(credits: number): string {
  return `STRIPE_PRICE_TOPUP_${credits}`;
}

export type EnvReader = (name: string) => string | undefined;

/**
 * Builds the price table from env. Entries whose env var is unset are simply
 * absent, so a partially configured Stripe account still works for the prices
 * it has.
 */
export function buildPriceTable(readEnv: EnvReader = optionalEnv): PriceTable {
  const table: PriceTable = {};
  for (const tier of tiers) {
    if (tier.monthlyUsd <= 0) {
      continue;
    }
    for (const cadence of ["monthly", "annual"] as const) {
      const priceId = readEnv(tierPriceEnvName(tier.key, cadence));
      if (priceId) {
        table[priceId] = { kind: "tier", tier: tier.key, cadence, creditsPerMonth: tier.creditsPerMonth };
      }
    }
  }
  for (const topUp of topUps) {
    const priceId = readEnv(topUpPriceEnvName(topUp.credits));
    if (priceId) {
      table[priceId] = { kind: "topup", credits: topUp.credits, expiresMonths: topUp.expiresMonths };
    }
  }
  return table;
}

export function priceIdForTier(tier: TierKey, cadence: BillingCadence, readEnv: EnvReader = optionalEnv): string | undefined {
  return readEnv(tierPriceEnvName(tier, cadence));
}

export function priceIdForTopUp(credits: number, readEnv: EnvReader = optionalEnv): string | undefined {
  return readEnv(topUpPriceEnvName(credits));
}
