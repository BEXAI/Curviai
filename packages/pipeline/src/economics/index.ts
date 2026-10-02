/**
 * Unit economics math (docs/phases/PHASE_20.md P20-04): revenue per credit
 * from the seed, the price rule and margins, as pure functions. It lives in
 * packages/pipeline so apps/web (the report script, the ops pages and the
 * weekly report) and trigger can both import it; trigger cannot import
 * apps/web. Database reads stay in apps/web/src/lib/ops/economics.ts.
 * Imported as @curvi/pipeline/economics. Every price, credit amount, fee
 * and margin comes from the seed (CLAUDE.md rule 2); nothing here is a
 * literal price.
 *
 * The price rule (decision 2): credits per generative still equal the p90
 * cost of a delivered still divided by (the lowest self serve revenue per
 * credit times (1 minus the target gross margin)), rounded up to the next
 * half credit. The floor is the minimum over every self serve price at both
 * cadences, top ups and every promotion offer: the founding offer at both
 * cadences and the cancel flow's discount (monthly plans only).
 */

import {
  economics as economicsSeed,
  foundingMemberOffer,
  retentionOffers,
  tierByKey,
  tiers,
  topUps,
  type EconomicsSeed,
  type TierDefinition,
  type TierKey,
  type TopUp,
} from "../seed";

export type OfferKind = "plan" | "top_up" | "founding" | "save_offer";
export type OfferCadence = "monthly" | "annual" | "once";

export interface CreditOffer {
  /** Stable key, e.g. "plan:growth:annual", "top_up:100", "founding:monthly". */
  key: string;
  label: string;
  kind: OfferKind;
  tier: TierKey | null;
  cadence: OfferCadence;
  /** What one invoice charges, in dollars, before tax. */
  usd: number;
  /** Credits that invoice grants. */
  credits: number;
  /** Dollars per credit before the payment fee. */
  revenuePerCredit: number;
  /** Dollars per credit after the payment fee. */
  netRevenuePerCredit: number;
  /** Sold through checkout today. A tier the seed marks `selfServe: false`
   * (Agency after P20-08) and its save offer are not. */
  selfServe: boolean;
}

export interface OfferSeed {
  tiers: readonly TierDefinition[];
  topUps: readonly TopUp[];
  founding: { monthlyUsd: number; annualUsd: number };
  /** The founding offer is the Starter plan at a lower price. */
  foundingTier: TierDefinition;
  saveOffer: { percentOff: number };
  paymentFee: EconomicsSeed["paymentFee"];
}

/** The offers as seeded today. */
export function seedOffers(): OfferSeed {
  return {
    tiers,
    topUps,
    founding: { monthlyUsd: foundingMemberOffer.monthlyUsd, annualUsd: foundingMemberOffer.annualUsd },
    foundingTier: tierByKey("starter"),
    saveOffer: { percentOff: retentionOffers.discount.percentOff },
    paymentFee: economicsSeed.paymentFee,
  };
}

function isSelfServe(tier: TierDefinition): boolean {
  return tier.selfServe;
}

/** Dollars kept from one charge after the payment fee. */
export function afterPaymentFee(usd: number, fee: EconomicsSeed["paymentFee"]): number {
  return usd * (1 - fee.percent) - fee.fixedUsd;
}

const TIER_NAMES: Record<TierKey, string> = {
  free: "Free",
  starter: "Starter",
  growth: "Growth",
  pro: "Pro",
  agency: "Agency",
};

/** Every way to buy credits, with revenue per credit before and after the
 * payment fee. */
export function creditOffers(seed: OfferSeed = seedOffers()): CreditOffer[] {
  const offers: CreditOffer[] = [];
  const add = (offer: Omit<CreditOffer, "revenuePerCredit" | "netRevenuePerCredit">): void => {
    if (offer.credits <= 0 || offer.usd <= 0) return;
    offers.push({
      ...offer,
      revenuePerCredit: offer.usd / offer.credits,
      netRevenuePerCredit: afterPaymentFee(offer.usd, seed.paymentFee) / offer.credits,
    });
  };
  for (const tier of seed.tiers) {
    if (tier.monthlyUsd <= 0) continue;
    const name = TIER_NAMES[tier.key];
    const selfServe = isSelfServe(tier);
    add({
      key: `plan:${tier.key}:monthly`,
      label: `${name} monthly`,
      kind: "plan",
      tier: tier.key,
      cadence: "monthly",
      usd: tier.monthlyUsd,
      credits: tier.creditsPerMonth,
      selfServe,
    });
    add({
      key: `plan:${tier.key}:annual`,
      label: `${name} annual`,
      kind: "plan",
      tier: tier.key,
      cadence: "annual",
      usd: tier.annualUsdPerMonth * 12,
      credits: tier.creditsPerMonth * 12,
      selfServe,
    });
    // The cancel flow's discount applies to monthly plans only.
    add({
      key: `save_offer:${tier.key}:monthly`,
      label: `${name} monthly with the ${seed.saveOffer.percentOff} percent save offer`,
      kind: "save_offer",
      tier: tier.key,
      cadence: "monthly",
      usd: (tier.monthlyUsd * (100 - seed.saveOffer.percentOff)) / 100,
      credits: tier.creditsPerMonth,
      selfServe,
    });
  }
  for (const topUp of seed.topUps) {
    add({
      key: `top_up:${topUp.credits}`,
      label: `Top up ${topUp.credits}`,
      kind: "top_up",
      tier: null,
      cadence: "once",
      usd: topUp.usd,
      credits: topUp.credits,
      selfServe: true,
    });
  }
  const founding = seed.foundingTier;
  add({
    key: "founding:monthly",
    label: `Founding ${TIER_NAMES[founding.key]} monthly`,
    kind: "founding",
    tier: founding.key,
    cadence: "monthly",
    usd: seed.founding.monthlyUsd,
    credits: founding.creditsPerMonth,
    selfServe: isSelfServe(founding),
  });
  add({
    key: "founding:annual",
    label: `Founding ${TIER_NAMES[founding.key]} annual`,
    kind: "founding",
    tier: founding.key,
    cadence: "annual",
    usd: seed.founding.annualUsd,
    credits: founding.creditsPerMonth * 12,
    selfServe: isSelfServe(founding),
  });
  return offers;
}

/** The self serve offer that brings the least per credit, before the fee
 * (the rule's floor) and after it. */
export function priceFloor(offers: readonly CreditOffer[] = creditOffers()): {
  gross: CreditOffer;
  net: CreditOffer;
} {
  const selfServe = offers.filter((offer) => offer.selfServe);
  if (selfServe.length === 0) {
    throw new Error("No self serve offer to take a price floor from.");
  }
  const gross = selfServe.reduce((min, offer) => (offer.revenuePerCredit < min.revenuePerCredit ? offer : min));
  const net = selfServe.reduce((min, offer) => (offer.netRevenuePerCredit < min.netRevenuePerCredit ? offer : min));
  return { gross, net };
}

/** Rounds up to the next half credit (2.53 to 3, 1.9 to 2, 2.5 stays). */
export function roundUpToHalfCredit(value: number): number {
  return Math.ceil(value * 2 - 1e-9) / 2;
}

/**
 * Credits per generative still from the price rule: the p90 cost over the
 * floor revenue per credit times (1 minus the target margin), rounded up
 * to the next half credit, and at least half a credit.
 */
export function creditsPerStill(input: {
  p90CostUsd: number;
  floorRevenuePerCredit: number;
  targetGrossMargin?: number;
}): number {
  const margin = input.targetGrossMargin ?? economicsSeed.targetGrossMargin;
  if (!(input.floorRevenuePerCredit > 0) || margin >= 1) {
    throw new Error("The price rule needs a positive floor and a margin below 1.");
  }
  const raw = input.p90CostUsd / (input.floorRevenuePerCredit * (1 - margin));
  return Math.max(0.5, roundUpToHalfCredit(raw));
}

/** Gross margin of revenue over cost, 0 to 1 (negative when cost exceeds
 * revenue); null without revenue. */
export function grossMargin(revenueUsd: number, costUsd: number): number | null {
  return revenueUsd > 0 ? 1 - costUsd / revenueUsd : null;
}

/** Linear interpolation percentile (p from 0 to 100), null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

export interface Distribution {
  count: number;
  mean: number | null;
  p50: number | null;
  p90: number | null;
}

export function distribution(values: readonly number[]): Distribution {
  return {
    count: values.length,
    mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    p50: percentile(values, 50),
    p90: percentile(values, 90),
  };
}

/** The shot methods a generative still is charged for (creditCosts
 * .generativeStill): a scene generated around the real cutout, or an edit. */
export const GENERATIVE_STILL_METHODS: readonly string[] = ["composite_generate", "edit_generate"];

// --- The report --------------------------------------------------------------

export interface DeliveredShot {
  jobId: string;
  method: string | null;
  costMicros: number;
  attempts: number;
}

export interface UndeliveredShot {
  jobId: string;
  costMicros: number;
}

export interface FinishedPack {
  jobId: string;
  cogsMicros: number;
  creditsCharged: number;
  /** LLM cost of the pack per provider family, at list price. */
  llmMicrosByFamily: Record<string, number>;
}

export interface StageCost {
  stage: string;
  status: string;
  rows: number;
  costMicros: number;
}

export interface EconomicsInputs {
  shots: DeliveredShot[];
  undelivered: UndeliveredShot[];
  packs: FinishedPack[];
  stages: StageCost[];
}

export interface EconomicsReport {
  days: number;
  /** Families whose LLM cost is paid from a provider credit on the report
   * day (llmCreditWindows), so it costs no cash. */
  creditFamilies: string[];
  perShotByMethod: Array<{ method: string; usd: Distribution }>;
  generativeStill: Distribution;
  perPack: { atListPrice: Distribution; withCredit: Distribution; creditsCharged: Distribution };
  retry: {
    deliveredShots: number;
    retriedShare: number | null;
    meanAttempts: number | null;
    /** Cost of shots that were not delivered (not charged), as a share of
     * all shot cost. */
    undeliveredCostShare: number | null;
  };
  stages: StageCost[];
  offers: CreditOffer[];
  floor: { gross: CreditOffer; net: CreditOffer };
  rule: {
    targetGrossMargin: number;
    currentCreditsPerStill: number;
    /** null when no generative still was delivered in the window. */
    fromGrossFloor: number | null;
    fromNetFloor: number | null;
    /** Gross margin of a still at the current price and the gross floor. */
    marginAtCurrentPrice: number | null;
  };
  /** Gross margin per pack: credits charged at the gross floor over the
   * cost with the credit. */
  packMarginAtFloor: Distribution;
}

const MICROS = 1_000_000;

function usd(micros: number): number {
  return micros / MICROS;
}

export function buildEconomicsReport(
  inputs: EconomicsInputs,
  options: {
    days: number;
    creditFamilies: readonly string[];
    currentCreditsPerStill: number;
    offers?: CreditOffer[];
    targetGrossMargin?: number;
  },
): EconomicsReport {
  const offers = options.offers ?? creditOffers();
  const floor = priceFloor(offers);
  const margin = options.targetGrossMargin ?? economicsSeed.targetGrossMargin;

  const byMethod = new Map<string, number[]>();
  for (const shot of inputs.shots) {
    const key = shot.method ?? "unknown";
    byMethod.set(key, [...(byMethod.get(key) ?? []), usd(shot.costMicros)]);
  }
  const perShotByMethod = [...byMethod.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([method, values]) => ({ method, usd: distribution(values) }));
  const stills = inputs.shots
    .filter((shot) => shot.method !== null && GENERATIVE_STILL_METHODS.includes(shot.method))
    .map((shot) => usd(shot.costMicros));
  const generativeStill = distribution(stills);

  const credit = new Set(options.creditFamilies);
  const withCredit = inputs.packs.map((pack) => {
    const covered = Object.entries(pack.llmMicrosByFamily)
      .filter(([family]) => credit.has(family))
      .reduce((sum, [, micros]) => sum + micros, 0);
    return usd(Math.max(0, pack.cogsMicros - covered));
  });

  const deliveredCost = inputs.shots.reduce((sum, shot) => sum + shot.costMicros, 0);
  const undeliveredCost = inputs.undelivered.reduce((sum, shot) => sum + shot.costMicros, 0);
  const retried = inputs.shots.filter((shot) => shot.attempts > 1).length;

  const p90 = generativeStill.p90;
  const fromGrossFloor =
    p90 === null ? null : creditsPerStill({ p90CostUsd: p90, floorRevenuePerCredit: floor.gross.revenuePerCredit, targetGrossMargin: margin });
  const fromNetFloor =
    p90 === null || floor.net.netRevenuePerCredit <= 0
      ? null
      : creditsPerStill({ p90CostUsd: p90, floorRevenuePerCredit: floor.net.netRevenuePerCredit, targetGrossMargin: margin });

  const packMargins = inputs.packs
    .map((pack, index) => grossMargin(pack.creditsCharged * floor.gross.revenuePerCredit, withCredit[index]))
    .filter((value): value is number => value !== null);

  return {
    days: options.days,
    creditFamilies: [...options.creditFamilies],
    perShotByMethod,
    generativeStill,
    perPack: {
      atListPrice: distribution(inputs.packs.map((pack) => usd(pack.cogsMicros))),
      withCredit: distribution(withCredit),
      creditsCharged: distribution(inputs.packs.map((pack) => pack.creditsCharged)),
    },
    retry: {
      deliveredShots: inputs.shots.length,
      retriedShare: inputs.shots.length ? retried / inputs.shots.length : null,
      meanAttempts: inputs.shots.length ? inputs.shots.reduce((sum, shot) => sum + shot.attempts, 0) / inputs.shots.length : null,
      undeliveredCostShare: deliveredCost + undeliveredCost > 0 ? undeliveredCost / (deliveredCost + undeliveredCost) : null,
    },
    stages: inputs.stages,
    offers,
    floor,
    rule: {
      targetGrossMargin: margin,
      currentCreditsPerStill: options.currentCreditsPerStill,
      fromGrossFloor,
      fromNetFloor,
      marginAtCurrentPrice: p90 === null ? null : grossMargin(options.currentCreditsPerStill * floor.gross.revenuePerCredit, p90),
    },
    packMarginAtFloor: distribution(packMargins),
  };
}
