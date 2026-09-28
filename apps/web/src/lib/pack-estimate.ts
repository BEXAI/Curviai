/**
 * Client safe credit estimate for the new pack form, and the amount the
 * server holds when it creates the job. The estimate is the deterministic
 * planner's own plan (the rule based planner the worker runs whenever the
 * LLM plan is turned down) for the product the estimate is built around:
 * photographed from three angles, with benefits to call out and no
 * measurements the seller confirmed. The planner selects by channel spec
 * with the same isSpecSelected rule as the runner, so the form lists and the
 * server holds only what the pack makes: the default pick of amazon.main,
 * amazon.secondary, shopify.product and meta.feed_1x1 holds no A plus
 * banner, Shopify hero, 4:5 crop or story. Every credit figure comes from the
 * seed credit table through the planner, never from literals.
 *
 * Shots whose method production cannot deliver yet (undeliverableShotMethods,
 * the same list the worker skips) cost nothing: when a video channel is
 * picked on a plan that includes it, they show as coming soon at 0 credits,
 * so a pack never holds credits for output it cannot ship.
 */

import { planShots } from "@curvi/pipeline/planner";
import type { ProductProfile, Shot } from "@curvi/pipeline/schemas";
import { withSellerAngles, type AngleRole } from "@curvi/pipeline/seller-inputs";
import { isShotMethodDeliverable, type TierKey } from "@curvi/pipeline/seed";
import { isMarketplaceChannel } from "@curvi/specs";

export type EstimateMode = "listing" | "concept";

export interface EstimateLine {
  label: string;
  credits: number;
  /** True for a plan feature that is not delivered yet; its credits are 0. */
  comingSoon?: boolean;
}

export interface PackEstimate {
  total: number;
  lines: EstimateLine[];
}

/**
 * The product the estimate and the hold are built around: three photographed
 * angles, two use contexts, benefits for the infographic and a size the
 * seller has not confirmed. A richer product fits the same hold, because the
 * worker's budget trim keeps a file for every picked spec before extras.
 */
export const ESTIMATE_REFERENCE_PRODUCT: ProductProfile = {
  productCount: 1,
  category: "home_kitchen",
  amazonProductTypeGuess: "KITCHEN",
  shopifyTaxonomyGuess: "Home & Garden > Kitchen",
  name: "Reference product",
  formFactor: "mug",
  materials: ["ceramic"],
  dominantColors: [{ name: "cream", hex: "#F2E8D8", coveragePct: 70 }],
  dimensions: { value: "10 x 10 x 12 cm", source: "unknown" },
  preserveText: [],
  preserveLogos: [],
  surface: { reflective: false, transparent: false, textured: false },
  features: ["pour over rim"],
  benefits: ["keeps coffee hot", "easy grip handle"],
  targetBuyer: "home coffee drinkers",
  useContexts: ["morning kitchen counter", "office desk"],
  photographedAngles: ["front", "45", "back"],
  missingAnglesNeeded: [],
  complianceFlags: ["none"],
  imageQuality: { usableForMain: true, issues: [] },
};

const REFERENCE_MEDIA_ID = "reference_front";

/**
 * What the seller told us about the product, so the estimate and the hold
 * cover the shots those inputs unlock: every photo role adds its angle to
 * the reference product's, and box contents and comparison facts add the
 * in_the_box and comparison images. Without these the worker's budget trim
 * would drop the very images the seller filled the form in for.
 */
export interface EstimateSellerInputs {
  angles?: readonly AngleRole[];
  hasBoxContents?: boolean;
  hasComparisonFacts?: boolean;
}

function referenceProductFor(inputs: EstimateSellerInputs | undefined): ProductProfile {
  return inputs?.angles && inputs.angles.length > 0
    ? withSellerAngles(ESTIMATE_REFERENCE_PRODUCT, inputs.angles)
    : ESTIMATE_REFERENCE_PRODUCT;
}

/**
 * The shots the deterministic planner plans for the reference product and
 * this channel pick, with no budget limit, video included where the plan
 * tier has it. Concept packs leave marketplace channels out first, exactly
 * as the runner does (plan 2.7). The estimate prices these, and demo mode
 * runs the deliverable ones.
 */
export function referencePackShots(
  channels: readonly string[],
  mode: EstimateMode,
  tier: TierKey,
  primaryMediaId: string = REFERENCE_MEDIA_ID,
  inputs?: EstimateSellerInputs,
): Shot[] {
  const picked = mode === "concept" ? channels.filter((c) => !isMarketplaceChannel(c)) : [...channels];
  if (picked.length === 0) {
    return [];
  }
  return planShots(referenceProductFor(inputs), {
    channels: picked,
    tier,
    creditBudget: Number.MAX_SAFE_INTEGER,
    primaryMediaId,
    hasBoxContents: inputs?.hasBoxContents === true,
    hasComparisonFacts: inputs?.hasComparisonFacts === true,
  }).shots;
}

interface LineName {
  one: string;
  /** Plural label with the count, for more than one shot. */
  many?: (count: number) => string;
}

/** Summary line per shot type; shot types that share a key share a line. */
function lineFor(shot: Shot): { key: string; name: LineName } {
  switch (shot.type) {
    case "amazon_main":
      return { key: "amazon_main", name: { one: "Amazon main image" } };
    case "alt_angle_white":
      // Priority 1 is the white front image that leads a listing other than Amazon's.
      return shot.priority === 1
        ? { key: "white_front", name: { one: "White front image" } }
        : {
            key: "alt_angle_white",
            name: { one: "Alternate angle on white", many: (n) => `Alternate angles on white, ${n}` },
          };
    case "cutout_png":
      return { key: "cutout_png", name: { one: "Transparent cutout" } };
    case "sweep_gray":
    case "sweep_brand":
      return { key: "sweep", name: { one: "Background sweep", many: (n) => `Background sweeps, ${n}` } };
    case "lifestyle":
      return { key: "lifestyle", name: { one: "Lifestyle scene", many: (n) => `Lifestyle scenes, ${n}` } };
    case "infographic":
      return { key: "infographic", name: { one: "Infographic" } };
    case "dimensions":
      return { key: "dimensions", name: { one: "Dimensions image" } };
    case "in_the_box":
      return { key: "in_the_box", name: { one: "In the box image" } };
    case "comparison":
      return { key: "comparison", name: { one: "Comparison image" } };
    case "aplus_banner":
      return { key: "aplus_banner", name: { one: "A plus banner", many: (n) => `A plus banners, ${n}` } };
    case "shopify_hero":
      return { key: "shopify_hero", name: { one: "Shopify hero" } };
    case "collection_thumb":
      return { key: "collection_thumb", name: { one: "Collection thumbnail" } };
    case "social_1x1":
    case "social_4x5":
    case "social_9x16":
      return { key: "social", name: { one: "Social crop", many: (n) => `Social crops, ${n}` } };
    case "social_2x3":
      return { key: "social_2x3", name: { one: "Pinterest pin" } };
    case "video_spin":
      return { key: "video_spin", name: { one: "Spin video" } };
    case "video_hero_6s":
      return { key: "video_hero_6s", name: { one: "Hero loop, 6 seconds" } };
    case "video_lifestyle_15s":
      return { key: "video_lifestyle_15s", name: { one: "Lifestyle clip, 15 seconds" } };
    case "video_ugc_hook":
      return { key: "video_ugc_hook", name: { one: "UGC hook ad" } };
  }
}

export function estimatePackCredits(
  channels: string[],
  mode: EstimateMode,
  tier: TierKey,
  inputs?: EstimateSellerInputs,
): PackEstimate {
  const groups = new Map<string, { name: LineName; count: number; credits: number; deliverable: boolean }>();
  for (const shot of referencePackShots(channels, mode, tier, REFERENCE_MEDIA_ID, inputs)) {
    const { key, name } = lineFor(shot);
    const deliverable = isShotMethodDeliverable(shot.method);
    const group = groups.get(key) ?? { name, count: 0, credits: 0, deliverable };
    group.count += 1;
    group.credits += deliverable ? shot.credits : 0;
    group.deliverable &&= deliverable;
    groups.set(key, group);
  }

  const lines: EstimateLine[] = [...groups.values()].map((group) => {
    const label = group.count > 1 && group.name.many ? group.name.many(group.count) : group.name.one;
    return group.deliverable
      ? { label, credits: group.credits }
      : { label: `${label}, coming soon`, credits: 0, comingSoon: true };
  });
  const total = Math.ceil(lines.reduce((sum, line) => sum + line.credits, 0));
  return { total, lines };
}
