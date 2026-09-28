/**
 * What each plan includes today and what is coming. Phase 10 decision 1: a
 * feature that does not run in production is never listed as included in
 * what a plan pays for; it may appear only under a "Coming soon" label.
 *
 * Each line names the site wide feature flags it depends on in
 * lib/marketing-facts (FEATURES), so /pricing and /app/billing can never
 * disagree with the rest of the site: flipping a flag there moves the line
 * here. Counts come from the seed entitlements; only wording lives here.
 */

import { entitlementsFor, type TierKey } from "@curvi/pipeline/seed";
import { FEATURES, type Availability, type FeatureKey } from "@/lib/marketing-facts";

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
    { label: "Everything in Starter", needs: [] },
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
