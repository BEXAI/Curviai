/**
 * What each plan includes today and what is coming. Phase 10 decision 1: a
 * feature that does not run in production is never listed as included in
 * what a plan pays for; it may appear only under a "Coming soon" label.
 * Flip a feature to live in the same change that ships it.
 *
 * Only wording lives here. Prices and credit amounts come from the seed.
 */

import type { TierKey } from "@curvi/pipeline/seed";

export type FeatureStatus = "live" | "coming_soon";

export interface PlanFeature {
  label: string;
  status: FeatureStatus;
}

const STILLS = "Compliant main images, lifestyle scenes and channel sized crops";
const REPORT = "Compliance report on every file";

const PLAN_FEATURES: Record<TierKey, PlanFeature[]> = {
  free: [
    { label: STILLS, status: "live" },
    { label: REPORT, status: "live" },
    { label: "Public share page for a pack", status: "coming_soon" },
  ],
  starter: [
    { label: "1 brand kit", status: "live" },
    { label: STILLS, status: "live" },
    { label: REPORT, status: "live" },
    { label: "Templated video", status: "coming_soon" },
  ],
  growth: [
    { label: "Everything in Starter", status: "live" },
    { label: "Generative video", status: "coming_soon" },
    { label: "Fresh Creative Drop every Monday", status: "coming_soon" },
    { label: "Shopify auto packs for new products", status: "coming_soon" },
  ],
  pro: [
    { label: "Everything in Starter", status: "live" },
    { label: "UGC hook ads", status: "coming_soon" },
    { label: "3 brand kits", status: "coming_soon" },
    { label: "Priority queue", status: "coming_soon" },
  ],
  agency: [
    { label: "Everything in Starter", status: "live" },
    { label: "10 client workspaces", status: "coming_soon" },
    { label: "Client review links", status: "coming_soon" },
    { label: "White label share pages", status: "coming_soon" },
  ],
};

export function planFeatures(tier: TierKey): PlanFeature[] {
  return PLAN_FEATURES[tier] ?? [];
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

export const COMING_SOON_LABEL = "Coming soon";
