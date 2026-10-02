/**
 * What each plan includes today and what is coming. Phase 10 decision 1: a
 * feature that does not run in production is never listed as included in
 * what a plan pays for; it may appear only under a "Coming soon" label.
 *
 * Each line names the site wide feature flags it depends on in
 * lib/marketing-facts (FEATURES), so /pricing and /app/billing can never
 * disagree with the rest of the site: flipping a flag there moves the line
 * here. Counts come from the seed entitlements; only wording lives here.
 *
 * docs/phases/PHASE_20.md P20-08: a plan card lists only what runs today
 * (includedFeatures). Lines that do not run yet are never inside a card;
 * they go to one "On the way" list under the cards (onTheWay), each with the
 * smallest plan that will get it.
 */

import { entitlementsFor, type TierKey } from "@curvi/pipeline/seed";
import { FEATURES, type Availability, type FeatureKey } from "@/lib/marketing-facts";
import { selfServeTierKeys, tierDisplayName, type PaidTierKey } from "./plans";

export type FeatureStatus = Availability;

export interface PlanFeature {
  label: string;
  status: FeatureStatus;
}

interface PlanLine {
  label: string;
  /** The line is included only while every one of these is live. */
  needs: readonly FeatureKey[];
}

const STILLS: PlanLine = {
  label: "Compliant main images, lifestyle scenes and channel sized crops",
  needs: ["whiteMainImage", "lifestyleScenes"],
};
const REPORT: PlanLine = { label: "Compliance report on every file", needs: ["complianceReport"] };

function brandKits(tier: TierKey): string {
  const count = entitlementsFor(tier).brandKits;
  return `${count} ${count === 1 ? "brand kit" : "brand kits"}`;
}

const PLAN_LINES: Record<TierKey, PlanLine[]> = {
  free: [STILLS, REPORT, { label: "Public share page for a pack", needs: ["sharePages"] }],
  starter: [
    { label: brandKits("starter"), needs: ["brandKitColors"] },
    STILLS,
    REPORT,
    { label: "Templated video", needs: ["video"] },
  ],
  growth: [
    { label: "Everything in Starter", needs: [] },
    { label: "Generative video", needs: ["video"] },
    { label: "Fresh Creative Drop every Monday", needs: ["freshCreativeDrop"] },
    { label: "Shopify auto packs for new products", needs: ["shopifyAutoPacks"] },
  ],
  pro: [
    { label: "Everything in Growth", needs: [] },
    { label: "UGC hook ads", needs: ["ugcAds"] },
    { label: brandKits("pro"), needs: ["multipleBrandKits"] },
    { label: "Priority queue", needs: ["priorityQueue"] },
  ],
  agency: [
    { label: "Everything in Starter", needs: [] },
    { label: `${entitlementsFor("agency").clientWorkspaces} client workspaces`, needs: ["agencyWorkspaces"] },
    { label: "Client review links", needs: ["reviewLinks"] },
    { label: "White label share pages", needs: ["whiteLabel"] },
  ],
};

function lineStatus(line: PlanLine): FeatureStatus {
  return line.needs.every((key) => FEATURES[key].status === "live") ? "live" : "coming_soon";
}

export function planFeatures(tier: TierKey): PlanFeature[] {
  return (PLAN_LINES[tier] ?? []).map((line) => ({ label: line.label, status: lineStatus(line) }));
}

/** Features a buyer gets today. Never contains a coming soon item. */
export function includedFeatures(tier: TierKey): string[] {
  return planFeatures(tier)
    .filter((feature) => feature.status === "live")
    .map((feature) => feature.label);
}

/** Features that are planned for this tier but do not run yet. */
export function comingSoonFeatures(tier: TierKey): string[] {
  return planFeatures(tier)
    .filter((feature) => feature.status === "coming_soon")
    .map((feature) => feature.label);
}

export interface OnTheWayLine {
  label: string;
  /** The smallest of the listed plans that will include it. */
  fromTier: PaidTierKey;
  /** "Starter and up", or just "Pro" for the largest listed plan. */
  plans: string;
}

/**
 * The one "On the way" list under the plan cards: every line of the listed
 * plans that does not run yet, once, with the smallest plan that gets it.
 * Defaults to the plans sold online, so Agency's lines stay off the page.
 */
export function onTheWay(tierKeys: readonly PaidTierKey[] = selfServeTierKeys): OnTheWayLine[] {
  const lines: OnTheWayLine[] = [];
  const last = tierKeys[tierKeys.length - 1];
  for (const tier of tierKeys) {
    for (const label of comingSoonFeatures(tier)) {
      if (lines.some((line) => line.label === label)) {
        continue;
      }
      lines.push({
        label,
        fromTier: tier,
        plans: tier === last ? tierDisplayName(tier) : `${tierDisplayName(tier)} and up`,
      });
    }
  }
  return lines;
}

/** Every site wide feature flag a plan card line reads, for the test that
 * keeps FEATURES and the seed's featureStatus in step. */
export function planCardFeatureKeys(): FeatureKey[] {
  return [...new Set(Object.values(PLAN_LINES).flatMap((lines) => lines.flatMap((line) => line.needs)))];
}
