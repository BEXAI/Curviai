/**
 * Client safe credit estimate for the new pack form. Costs come from the
 * seed credit table in @curvi/pipeline/seed, never from literals. The
 * composition mirrors the deterministic planner's default pack for a product
 * photographed from three angles; the job itself reserves the exact amount
 * from the real planner on the server.
 */

import { creditCosts, type TierKey } from "@curvi/pipeline/seed";
import { isMarketplaceSpec } from "@curvi/specs";

export type EstimateMode = "listing" | "concept";

export interface EstimateLine {
  label: string;
  credits: number;
}

export interface PackEstimate {
  total: number;
  lines: EstimateLine[];
}

const HERO_LOOP_SECONDS = 6;
const LIFESTYLE_CLIP_SECONDS = 15;

function hasFamily(channels: string[], family: string): boolean {
  return channels.some((c) => c === family || c.startsWith(`${family}.`));
}

export function estimatePackCredits(channels: string[], mode: EstimateMode, tier: TierKey): PackEstimate {
  const lines: EstimateLine[] = [];
  if (channels.length === 0) {
    return { total: 0, lines };
  }

  const marketplaceSelected = channels.some((c) => isMarketplaceSpec(c));
  const amazon = hasFamily(channels, "amazon");
  const shopify = hasFamily(channels, "shopify");

  // Concept mode outputs are excluded from marketplace packs, so marketplace
  // only assets drop out of the estimate.
  const marketplaceAssets = mode === "listing" && marketplaceSelected;

  if (marketplaceAssets && amazon) {
    lines.push({ label: "Amazon main image", credits: creditCosts.deterministic });
    lines.push({ label: "A plus banners, 2", credits: 2 * creditCosts.deterministic });
  }
  lines.push({ label: "Alternate angles on white, 2", credits: 2 * creditCosts.deterministic });
  lines.push({
    label: "Cutout and background sweeps, 3",
    credits: 3 * creditCosts.deterministic,
  });
  lines.push({ label: "Lifestyle scenes, 2", credits: 2 * creditCosts.generativeStill });
  lines.push({ label: "Infographic", credits: creditCosts.deterministic });
  lines.push({ label: "Social crops, 3", credits: 3 * creditCosts.deterministic });
  if (marketplaceAssets && shopify) {
    lines.push({ label: "Shopify hero", credits: creditCosts.generativeStill });
    lines.push({ label: "Collection thumbnail", credits: creditCosts.deterministic });
  }

  const generativeVideoTiers: TierKey[] = ["growth", "pro", "agency"];
  if (generativeVideoTiers.includes(tier)) {
    lines.push({
      label: "Hero loop, 6 seconds",
      credits: HERO_LOOP_SECONDS * creditCosts.generativeVideoPerSecondLite,
    });
  }
  const proTiers: TierKey[] = ["pro", "agency"];
  if (proTiers.includes(tier)) {
    lines.push({
      label: "Lifestyle clip, 15 seconds",
      credits: LIFESTYLE_CLIP_SECONDS * creditCosts.generativeVideoPerSecondLite,
    });
    lines.push({ label: "UGC hook ad", credits: creditCosts.ugcAvatarAd });
  }

  const total = Math.ceil(lines.reduce((sum, line) => sum + line.credits, 0));
  return { total, lines };
}
