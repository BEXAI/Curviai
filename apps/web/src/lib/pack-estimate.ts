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
 *
 * The hold follows the seller's output options (PHASE_15): with `output` the
 * planner plans the pack's real photo count, one original_photo per kept
 * photo, and leaves out the extras the seller turned off, so the form, the
 * createJob hold and the demo plan agree with the runner.
 */

import { extraOn, keepMediaIdsFor, type OutputPlanFlags, type PlanPhoto } from "@curvi/pipeline/output-options";
import { planShots, type PlanOptions } from "@curvi/pipeline/planner";
import type { ProductProfile, Shot } from "@curvi/pipeline/schemas";
import { extraVariationCredits } from "@curvi/pipeline/variations";
import { planAngleKey, withSellerAngles, type AngleRole } from "@curvi/pipeline/seller-inputs";
import { adsFormats, isShotMethodDeliverable, stillStyle, type TierKey } from "@curvi/pipeline/seed";
import { getSpec, hasSpec, isMarketplaceChannel, requiresWhiteBackground } from "@curvi/specs";

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
 * Spare lines the ads reference product draws on. With the ads family on,
 * the hold covers the most the seed lets a real product make: a carousel
 * with maxBenefitSlides benefit slides, a details slide and an in the box
 * slide, and an ad pack of maxVariants versions. Each line is short enough
 * for every placement's text limit, so no placement turns it away. The
 * worker releases what the real product does not make; holding less would
 * let its budget trim drop a slide, and with it the whole carousel.
 */
const ADS_REFERENCE_BENEFITS = ["keeps coffee hot", "easy grip handle", "fits most cup holders", "stacks neatly"];
const ADS_REFERENCE_FEATURES = ["pour over rim", "wide stable base", "glazed inside", "matte outside", "thick walls"];

/** The seller's box contents as the estimate knows them: only whether any were typed. */
const REFERENCE_BOX_CONTENTS = ["Mug"];

/**
 * The reference product with enough lines for the largest carousel and ad
 * pack the seed allows: maxBenefitSlides benefits, then features until the
 * name, benefits and features give maxVariants headlines.
 */
function adsReferenceProduct(profile: ProductProfile): ProductProfile {
  const benefits = [...new Set([...profile.benefits, ...ADS_REFERENCE_BENEFITS])].slice(
    0,
    Math.max(profile.benefits.length, adsFormats.carousel.maxBenefitSlides),
  );
  const featureCount = Math.max(
    profile.features.length,
    adsFormats.carousel.maxDetailLines,
    adsFormats.adPack.maxVariants - 1 - benefits.length,
  );
  const features = [...new Set([...profile.features, ...ADS_REFERENCE_FEATURES])].slice(0, featureCount);
  return { ...profile, benefits, features };
}

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
  /** Press quotes or awards for the A+ endorsement module (PHASE_16). */
  hasEndorsements?: boolean;
  /**
   * The seller's output options as plan flags. Absent means today's pack.
   * Its keepMediaIds are matched to the estimate's photos by position when
   * output.photos has the same count; otherwise every photo follows
   * `background`.
   */
  output?: OutputPlanFlags;
  /**
   * The pack's photos in order: the form's uploads (or the product's stored
   * photo count), or createJob's merged media with their sizes. Absent, the
   * count is output.photos, then the reference product's three angles. A
   * photo of unknown size is treated as fitting every spec, so the form's
   * figure is an upper bound.
   */
  photos?: readonly EstimatePhoto[];
  /** The resolved background color, for the line labels only. Absent means white. */
  colorHex?: string;
}

/** One photo as the estimate knows it. */
export interface EstimatePhoto {
  /** The role the seller gave the photo, when known. */
  angle?: AngleRole | null;
  width?: number;
  height?: number;
}

/** Synthetic media id of the estimate's photo at this 1 based position. */
export function referencePhotoId(position: number): string {
  return `reference_photo_${position}`;
}

interface EstimatePlan {
  output: OutputPlanFlags;
  mediaIdsByAngle: Partial<Record<string, string>>;
}

/**
 * The plan flags for the estimate's synthetic photos: ids reference_photo_1
 * to n, except the front photo, whose id is primaryMediaId; angles from the
 * seller's roles, then the reference product's other angles in order; the
 * kept set carried over from the flags.
 */
function estimatePlanFor(
  profile: ProductProfile,
  inputs: EstimateSellerInputs,
  output: OutputPlanFlags,
  primaryMediaId: string,
): EstimatePlan {
  const given: ReadonlyArray<{ angle?: string; width?: number; height?: number }> = inputs.photos
    ? inputs.photos.map((photo) => ({
        ...(photo.angle ? { angle: planAngleKey(photo.angle) } : {}),
        ...(photo.width !== undefined ? { width: photo.width } : {}),
        ...(photo.height !== undefined ? { height: photo.height } : {}),
      }))
    : output.photos;
  const count = given.length > 0 ? given.length : profile.photographedAngles.length;
  const claimed = new Set(given.map((photo) => photo.angle).filter((angle): angle is string => !!angle));
  const spare = profile.photographedAngles.filter((angle) => !claimed.has(angle));
  const angles = Array.from({ length: count }, (_, i) => given[i]?.angle ?? spare.shift());
  const frontIndex = Math.max(0, angles.indexOf("front"));
  const photos: PlanPhoto[] = angles.map((angle, i) => ({
    id: i === frontIndex ? primaryMediaId : referencePhotoId(i + 1),
    ...(angle !== undefined ? { angle } : {}),
    ...(given[i]?.width !== undefined ? { width: given[i].width } : {}),
    ...(given[i]?.height !== undefined ? { height: given[i].height } : {}),
  }));
  const ids = photos.map((photo) => photo.id);
  const keepMediaIds =
    output.photos.length === count
      ? ids.filter((_, i) => output.keepMediaIds.includes(output.photos[i].id))
      : keepMediaIdsFor(output, ids);
  const mediaIdsByAngle: Partial<Record<string, string>> = {};
  for (const photo of photos) {
    if (photo.angle !== undefined) {
      mediaIdsByAngle[photo.angle] ??= photo.id;
    }
  }
  return { output: { ...output, keepMediaIds, photos }, mediaIdsByAngle };
}

interface ReferencePack {
  shots: Shot[];
  /** Media ids of the kept photos. */
  kept: ReadonlySet<string>;
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
  return referencePack(channels, mode, tier, primaryMediaId, inputs).shots;
}

function referencePack(
  channels: readonly string[],
  mode: EstimateMode,
  tier: TierKey,
  primaryMediaId: string,
  inputs: EstimateSellerInputs | undefined,
): ReferencePack {
  const picked = mode === "concept" ? channels.filter((c) => !isMarketplaceChannel(c)) : [...channels];
  if (picked.length === 0) {
    return { shots: [], kept: new Set() };
  }
  const adsOn = inputs?.output !== undefined && extraOn(inputs.output.extras, "ads");
  const base = referenceProductFor(inputs);
  const profile = adsOn ? adsReferenceProduct(base) : base;
  const plan = inputs?.output ? estimatePlanFor(profile, inputs, inputs.output, primaryMediaId) : null;
  const hasBoxContents = inputs?.hasBoxContents === true;
  const options: PlanOptions = {
    channels: picked,
    tier,
    creditBudget: Number.MAX_SAFE_INTEGER,
    primaryMediaId,
    hasBoxContents,
    // The carousel's in the box slide needs the lines themselves, not only
    // the flag, so the hold counts it whenever the seller typed any.
    ...(adsOn && hasBoxContents ? { boxContents: REFERENCE_BOX_CONTENTS } : {}),
    hasComparisonFacts: inputs?.hasComparisonFacts === true,
    hasEndorsements: inputs?.hasEndorsements === true,
    ...(plan ? { output: plan.output, mediaIdsByAngle: plan.mediaIdsByAngle } : {}),
  };
  return { shots: planShots(profile, options).shots, kept: new Set(plan?.output.keepMediaIds ?? []) };
}

interface LineName {
  one: string;
  /** Plural label with the count, for more than one shot. */
  many?: (count: number) => string;
}

/** What the line labels need to know beyond the shot. */
interface LineContext {
  /** Media ids of the kept photos. */
  kept: ReadonlySet<string>;
  /** The pack's background color is white. */
  colorIsWhite: boolean;
}

const MADE_WHITE_LINE: { key: string; name: LineName } = {
  key: "made_white",
  name: {
    one: "Made white for channels that require it",
    many: (n) => `Made white for channels that require it, ${n}`,
  },
};

const VARIATIONS_LINE: { key: string; name: LineName } = {
  key: "scene_variations",
  name: {
    one: "Extra version of a scene",
    many: (n) => `Extra versions of scenes, ${n}`,
  },
};

/** True when the shot lands on the seller's color on some spec it targets. */
function onSellerColor(shot: Shot, context: LineContext): boolean {
  return (
    !context.colorIsWhite &&
    shot.channels.some((specId) => hasSpec(specId) && !requiresWhiteBackground(getSpec(specId)))
  );
}

/** Summary line per shot type; shot types that share a key share a line. */
function lineFor(shot: Shot, context: LineContext): { key: string; name: LineName } {
  switch (shot.type) {
    case "amazon_main":
      // A kept photo's white file is made only for the channels that require it.
      return context.kept.has(shot.sourceMediaId)
        ? MADE_WHITE_LINE
        : { key: "amazon_main", name: { one: "Amazon main image" } };
    case "alt_angle_white":
      if (context.kept.has(shot.sourceMediaId)) {
        return MADE_WHITE_LINE;
      }
      // Priority 1 is the white front image that leads a listing other than Amazon's.
      if (shot.priority === 1) {
        return onSellerColor(shot, context)
          ? { key: "color_front", name: { one: "Front image on your background" } }
          : { key: "white_front", name: { one: "White front image" } };
      }
      return onSellerColor(shot, context)
        ? {
            key: "alt_angle_color",
            name: { one: "Other angle on your background", many: (n) => `Other angles on your background, ${n}` },
          }
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
    case "aplus_pain_points":
      return { key: "aplus_pain_points", name: { one: "A plus problems solved module" } };
    case "aplus_features":
      return { key: "aplus_features", name: { one: "A plus features module" } };
    case "aplus_ingredients":
      return { key: "aplus_ingredients", name: { one: "A plus materials module" } };
    case "aplus_results":
      return { key: "aplus_results", name: { one: "A plus results module" } };
    case "aplus_how_to":
      return { key: "aplus_how_to", name: { one: "A plus how to use module" } };
    case "aplus_endorsement":
      return { key: "aplus_endorsement", name: { one: "A plus press quotes and awards module" } };
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
    case "pin_moodboard":
      return { key: "pin_moodboard", name: { one: "Moodboard pin" } };
    case "carousel_slide":
      // A carousel is one line: its slides share one canvas, and with scenes
      // on its one scene is charged on the first slide (founder decision 4).
      return { key: "carousel", name: { one: "Carousel, 1 slide", many: (n) => `Carousel, ${n} slides` } };
    case "ad_variant":
      return { key: "ad_variant", name: { one: "Ad", many: (n) => `Ads, ${n} versions` } };
    case "video_spin":
      return { key: "video_spin", name: { one: "Spin video" } };
    case "video_hero_6s":
      return { key: "video_hero_6s", name: { one: "Hero loop, 6 seconds" } };
    case "video_lifestyle_15s":
      return { key: "video_lifestyle_15s", name: { one: "Lifestyle clip, 15 seconds" } };
    case "video_ugc_hook":
      return { key: "video_ugc_hook", name: { one: "UGC hook ad" } };
    case "original_photo":
      return {
        key: "original_photo",
        name: { one: "Your photo, resized for each channel", many: (n) => `Your photos, resized for each channel, ${n}` },
      };
  }
}

/** The requested specs an estimated pack makes files for, and the ones it
 * leaves out. */
export interface EstimatedSpecCoverage {
  /** Specs a deliverable shot targets, in request order. */
  made: string[];
  /** Specs only shots that do not ship yet target (0 credits). */
  comingSoon: string[];
  /** Specs no planned shot targets with these photos and choices, for
   * example a kept photo too small for the channel. */
  notMade: string[];
}

/**
 * Which requested specs the pack estimatePackCredits prices makes files for
 * (PHASE_19 P19-16, estimate_pack's left_out). The same plan from the same
 * inputs, so an assistant can say which channels a pack leaves out before
 * any credit is held.
 */
export function estimatedSpecCoverage(
  channels: readonly string[],
  mode: EstimateMode,
  tier: TierKey,
  inputs?: EstimateSellerInputs,
): EstimatedSpecCoverage {
  const shots = referencePack(channels, mode, tier, REFERENCE_MEDIA_ID, inputs).shots;
  const deliverable = new Set<string>();
  const undeliverable = new Set<string>();
  for (const shot of shots) {
    const target = isShotMethodDeliverable(shot.method) ? deliverable : undeliverable;
    for (const specId of shot.channels) {
      target.add(specId);
    }
  }
  const requested = [...new Set(channels)];
  return {
    made: requested.filter((specId) => deliverable.has(specId)),
    comingSoon: requested.filter((specId) => !deliverable.has(specId) && undeliverable.has(specId)),
    notMade: requested.filter((specId) => !deliverable.has(specId) && !undeliverable.has(specId)),
  };
}

export function estimatePackCredits(
  channels: string[],
  mode: EstimateMode,
  tier: TierKey,
  inputs?: EstimateSellerInputs,
): PackEstimate {
  const groups = new Map<string, { name: LineName; count: number; credits: number; deliverable: boolean }>();
  const pack = referencePack(channels, mode, tier, REFERENCE_MEDIA_ID, inputs);
  const white = stillStyle.whiteHex.toUpperCase();
  const context: LineContext = {
    kept: pack.kept,
    colorIsWhite: (inputs?.colorHex ?? white).toUpperCase() === white,
  };
  const add = (key: string, name: LineName, count: number, credits: number, deliverable: boolean): void => {
    const group = groups.get(key) ?? { name, count: 0, credits: 0, deliverable };
    group.count += count;
    group.credits += deliverable ? credits : 0;
    group.deliverable &&= deliverable;
    groups.set(key, group);
  };
  for (const shot of pack.shots) {
    const { key, name } = lineFor(shot, context);
    const deliverable = isShotMethodDeliverable(shot.method);
    // Extra scene versions (PHASE_16 workstream 6) get their own line, at
    // the seed price per version, so the scene line keeps its own price.
    const extra = shot.variations !== undefined ? extraVariationCredits(shot.variations) : 0;
    add(key, name, 1, shot.credits - extra, deliverable);
    if (shot.variations !== undefined) {
      add(VARIATIONS_LINE.key, VARIATIONS_LINE.name, shot.variations - 1, extra, deliverable);
    }
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
