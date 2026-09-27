/**
 * Deterministic demo shot plan. Mirrors the default pack of the rule based
 * planner in @curvi/pipeline for a product photographed from three angles,
 * built here from the sharp free subpaths only: shot shapes validate against
 * the Shot schema and every credit figure comes from the seed credit table.
 * The real pipeline planner takes over in db mode workers.
 */

import { Shot, ShotList } from "@curvi/pipeline/schemas";
import { creditCosts, type TierKey } from "@curvi/pipeline/seed";

function hasFamily(channels: string[], family: string): boolean {
  return channels.some((c) => c === family || c.startsWith(`${family}.`));
}

export function planDemoShots(channels: string[], tier: TierKey): Shot[] {
  const amazon = hasFamily(channels, "amazon");
  const shopify = hasFamily(channels, "shopify");
  const google = hasFamily(channels, "google");

  const secondary: string[] = [];
  if (amazon) secondary.push("amazon.secondary");
  if (shopify) secondary.push("shopify.product");
  if (google) secondary.push("google.merchant.lifestyle");
  if (secondary.length === 0) secondary.push("shopify.product");

  const shots: Shot[] = [];
  const push = (
    type: Shot["type"],
    method: Shot["method"],
    shotChannels: string[],
    credits: number,
    scene?: string,
  ) => {
    shots.push({
      id: `s${String(shots.length + 1).padStart(2, "0")}_${type}`,
      type,
      sourceMediaId: "demo_source_1",
      method,
      channels: shotChannels,
      stylePreset: method === "composite_generate" ? "minimal_studio" : "none",
      ...(scene ? { scene } : {}),
      credits,
      priority: shots.length + 1,
    });
  };

  if (amazon) {
    push("amazon_main", "deterministic", ["amazon.main"], creditCosts.deterministic);
  }
  push("alt_angle_white", "deterministic", secondary, creditCosts.deterministic, "45 angle on white");
  push("alt_angle_white", "deterministic", secondary, creditCosts.deterministic, "side angle on white");
  push("cutout_png", "deterministic", secondary, creditCosts.deterministic);
  push("sweep_gray", "deterministic", secondary, creditCosts.deterministic);
  push("sweep_brand", "deterministic", secondary, creditCosts.deterministic);
  push("lifestyle", "composite_generate", secondary, creditCosts.generativeStill, "kitchen counter");
  push("lifestyle", "composite_generate", secondary, creditCosts.generativeStill, "office desk");
  push("infographic", "template", secondary, creditCosts.deterministic);
  if (amazon) {
    push("aplus_banner", "template", ["amazon.aplus.basic_header"], creditCosts.deterministic);
    push("aplus_banner", "template", ["amazon.aplus.basic_header"], creditCosts.deterministic);
  }
  if (shopify) {
    push("shopify_hero", "composite_generate", ["shopify.hero_banner"], creditCosts.generativeStill);
    push("collection_thumb", "deterministic", ["shopify.product"], creditCosts.deterministic);
  }
  push("social_1x1", "template", ["meta.feed_1x1"], creditCosts.deterministic);
  push("social_4x5", "template", ["meta.feed_4x5"], creditCosts.deterministic);
  push("social_9x16", "template", ["meta.story_9x16"], creditCosts.deterministic);

  const generativeVideoTiers: TierKey[] = ["growth", "pro", "agency"];
  if (generativeVideoTiers.includes(tier)) {
    push("video_hero_6s", "video_generate", ["video.social_9x16"], 6 * creditCosts.generativeVideoPerSecondLite);
  }
  const proTiers: TierKey[] = ["pro", "agency"];
  if (proTiers.includes(tier)) {
    push("video_lifestyle_15s", "video_generate", ["video.social_9x16"], 15 * creditCosts.generativeVideoPerSecondLite);
    push("video_ugc_hook", "avatar", ["video.social_9x16"], creditCosts.ugcAvatarAd);
  }

  // Validate against the source of truth schema before handing the plan out.
  return ShotList.parse({ shots, skipped: [] }).shots;
}
