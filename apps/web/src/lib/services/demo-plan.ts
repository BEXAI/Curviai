/**
 * Deterministic demo shot plan. Mirrors the default pack of the rule based
 * planner in @curvi/pipeline for a product photographed from three angles,
 * built here from the sharp free subpaths only: shot shapes validate against
 * the Shot schema and every credit figure comes from the seed credit table.
 * The real pipeline planner takes over in db mode workers.
 */

import { Shot, ShotList } from "@curvi/pipeline/schemas";
import { creditCosts, isEntitled, isShotMethodDeliverable, type TierKey } from "@curvi/pipeline/seed";
import { isMarketplaceSpec } from "@curvi/specs";

function hasFamily(channels: string[], family: string): boolean {
  return channels.some((c) => c === family || c.startsWith(`${family}.`));
}

/** Concept packs leave marketplace channels out before planning, exactly as
 * the runner does (plan 2.7): synthetic renders never go to a marketplace. */
export function planDemoShots(
  requestedChannels: string[],
  tier: TierKey,
  mode: "listing" | "concept" = "listing",
): Shot[] {
  const channels = mode === "concept" ? requestedChannels.filter((c) => !isMarketplaceSpec(c)) : requestedChannels;
  const amazon = hasFamily(channels, "amazon");
  const shopify = hasFamily(channels, "shopify");
  const google = hasFamily(channels, "google");

  const secondary: string[] = [];
  if (amazon) secondary.push("amazon.secondary");
  if (shopify) secondary.push("shopify.product");
  if (google) secondary.push("google.merchant.lifestyle");
  if (secondary.length === 0 && mode === "listing") secondary.push("shopify.product");

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
  // Product page shots need a marketplace or store channel to land in.
  if (secondary.length > 0) {
    push("alt_angle_white", "deterministic", secondary, creditCosts.deterministic, "45 angle on white");
    push("alt_angle_white", "deterministic", secondary, creditCosts.deterministic, "side angle on white");
    push("cutout_png", "deterministic", secondary, creditCosts.deterministic);
    push("sweep_gray", "deterministic", secondary, creditCosts.deterministic);
    push("sweep_brand", "deterministic", secondary, creditCosts.deterministic);
    push("lifestyle", "composite_generate", secondary, creditCosts.generativeStill, "kitchen counter");
    push("lifestyle", "composite_generate", secondary, creditCosts.generativeStill, "office desk");
    push("infographic", "template", secondary, creditCosts.deterministic);
  }
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

  // Video and avatar shots follow the same seed gates as production: the
  // plan must include the feature (isEntitled, as the planner checks) and
  // the method must ship today (isShotMethodDeliverable, the list the db
  // runtime skips and pack estimates leave out). While video is coming soon
  // no demo pack plans or holds credits for it.
  const videoShips = isShotMethodDeliverable("video_generate");
  if (videoShips && isEntitled(tier, "generativeVideo")) {
    push("video_hero_6s", "video_generate", ["video.social_9x16"], 6 * creditCosts.generativeVideoPerSecondLite);
  }
  if (videoShips && isEntitled(tier, "lifestyleVideo")) {
    push("video_lifestyle_15s", "video_generate", ["video.social_9x16"], 15 * creditCosts.generativeVideoPerSecondLite);
  }
  if (isShotMethodDeliverable("avatar") && isEntitled(tier, "ugcAds")) {
    push("video_ugc_hook", "avatar", ["video.social_9x16"], creditCosts.ugcAvatarAd);
  }

  // Validate against the source of truth schema before handing the plan out.
  return ShotList.parse({ shots, skipped: [] }).shots;
}
