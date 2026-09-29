/**
 * Rule based fallback shot planner. Pure code over ProductProfile implementing
 * the shot_planner rules from CURVI_BUILD_PLAN.md section 5.3: used in demo
 * mode and tests when no LLM is available, and whenever the LLM plan is
 * rejected. Output validates against ShotList.
 *
 * Channel routing reads each spec's rules from the registry (CLAUDE.md rule
 * 2): a shot only targets a selected spec whose background, text and
 * transparency rules its image can meet. Selection is by channel spec, with
 * the same isSpecSelected rule the runner and the web estimate use: no shot
 * ever targets a spec the seller did not pick. Etsy, eBay, Walmart and TikTok
 * Shop get deterministic and template images only (a white front image
 * first, then white angles and whatever else the spec allows); Pinterest gets
 * a 2:3 pin crop; Google's main slot takes the same white front image.
 */
import {
  channelFileLimit,
  getSpec,
  hasSpec,
  isSpecSelected,
  listSpecs,
  refusesOverlays,
  requiresWhiteBackground,
} from "@curvi/specs";
import {
  ADDED_OVERLAYS_REASON,
  BUNDLE_OFF_REASON,
  GALLERY_SLOTS,
  SELLER_OFF_REASON,
  SOURCE_TOO_SMALL_REASON,
  bundleMaxSecondary,
  bundleOf,
  bundleShotTypes,
  extraFamilyOf,
  isSecondaryShot,
  originalScale,
  sceneCountOf,
  specAcceptsImage,
  whiteRequiredGallerySpecIds,
  type OutputPlanFlags,
  type PlanPhoto,
  type PlannedImageKind,
} from "../output-options";
import { creditCosts, isEntitled, type TierKey } from "../seed/credits";
import {
  aplusModules,
  lifestyleFallbackScenes,
  sceneCountOptions,
  type AplusModuleKey,
  type AplusModuleSeed,
} from "../seed/templates";
import { capAplusModules, moduleSkipReason, plannedModuleLines } from "../aplus-copy";
import { applyVariations } from "../variations";
import { ProductProfile, Shot, ShotList, type ShotMethod } from "../schemas";
import { printableEndorsements, printableSellerLines } from "../seller-inputs";

export interface PlanOptions {
  /** Selected channels or channel families, e.g. ["amazon", "shopify.product"]. */
  channels: string[];
  tier: TierKey;
  creditBudget: number;
  /** Seller listed what is in the box. */
  hasBoxContents?: boolean;
  /** Seller supplied comparison facts. */
  hasComparisonFacts?: boolean;
  /** What is in the box, one line per item, printed as the in_the_box
   * shot's callouts. A non empty list also counts as hasBoxContents. */
  boxContents?: readonly string[];
  /** Comparison facts the seller can back up, printed as the comparison
   * shot's callouts. A non empty list also counts as hasComparisonFacts. */
  comparisonFacts?: readonly string[];
  /** Seller added press quotes or awards for the A+ endorsement module. */
  hasEndorsements?: boolean;
  /** The seller's press quotes or awards, one per line, printed as the
   * endorsement module's lines exactly as typed. A non empty list also
   * counts as hasEndorsements. */
  endorsements?: readonly string[];
  /** Seller uploaded a video. */
  hasVideoSource?: boolean;
  /** Media id per photographed angle. Falls back to primaryMediaId. */
  mediaIdsByAngle?: Partial<Record<string, string>>;
  primaryMediaId?: string;
  /**
   * Shot methods production cannot deliver yet (the seed's
   * undeliverableShotMethods, for example video_generate while video is
   * coming soon). Shots with these methods are never planned: they go to
   * skipped with UNDELIVERABLE_METHOD_REASON before the channel limits and
   * the budget trim, so they hold no channel slot and no credits and never
   * push out a shot that can ship. This reason wins over a tier or photo
   * reason, since no plan and no photo gets them today.
   */
  undeliverableMethods?: readonly ShotMethod[];
  /**
   * The seller's output options as plan flags (PHASE_15). Absent means
   * today's pack: every photo removed and every extra on. Kept photos
   * (keepMediaIds) each plan one original_photo; extras that are off are
   * skipped with SELLER_OFF_REASON before the channel limits.
   */
  output?: OutputPlanFlags;
}

/**
 * A skipped entry as the planner builds it. A shot the seller turned off
 * also records the picked specs it would have served, so coverSellerOffSpecs
 * can tell a spec the seller emptied from one empty for another reason.
 * ShotList.parse strips `channels`, so it never reaches a stored plan.
 */
export interface SkippedShot {
  type: string;
  reason: string;
  channels?: string[];
}

type Angle = ProductProfile["photographedAngles"][number];

const VIDEO_SECONDS = { video_hero_6s: 6, video_lifestyle_15s: 15 } as const;

/** Reason recorded in skipped for a shot whose method production cannot deliver. */
export const UNDELIVERABLE_METHOD_REASON = "provider not enabled";

/** Reason recorded in skipped for a shot that no selected channel spec can take. */
export const NO_COMPATIBLE_CHANNEL_REASON = "no selected channel takes this kind of image";

/** Reason recorded for a shot trimmed from the budget that targets no selected channel. */
export const CHANNEL_NOT_SELECTED_REASON = "channel not selected";

/** Reason recorded for a shot trimmed to stay within the credit budget. */
export const CREDIT_BUDGET_REASON = "credit budget";

/** Reason recorded for the in_the_box shot when the seller listed no contents. */
export const NO_BOX_CONTENTS_REASON = "seller did not list contents";

/** Reason recorded for the comparison shot when the seller supplied no facts. */
export const NO_COMPARISON_FACTS_REASON = "seller did not supply comparison facts";

// PlannedImageKind, specAcceptsImage and the listing gallery slots live in
// the client safe options module (PHASE_15), so the form, the estimate and
// this planner read one definition.
export { specAcceptsImage, type PlannedImageKind } from "../output-options";

const PINTEREST_PIN_SPEC = "pinterest.pin";
const AMAZON_MAIN_SPEC = "amazon.main";
const AMAZON_APLUS_SPEC = "amazon.aplus.basic_header";
const SHOPIFY_HERO_SPEC = "shopify.hero_banner";
const SHOPIFY_PRODUCT_SPEC = "shopify.product";
/** Google's main slot takes the white front image, like amazon.main. */
const GOOGLE_MAIN_SPEC = "google.merchant.main";

/** Channel family of a spec id or family string: "etsy.listing" is "etsy". */
function familyOf(channel: string): string {
  return channel.split(".")[0] ?? channel;
}

/** Longest label a Shot callout may carry (ShotList schema). */
const MAX_CALLOUT_CHARS = 40;

/**
 * The dimensions label to print, or null when it cannot be printed whole.
 * A trailing parenthetical (often the metric conversion) is dropped when
 * that makes the label fit. A measurement is never cut in the middle, since
 * a truncated figure would print a wrong fact on a charged image.
 */
export function printableDimensions(value: string): string | null {
  const label = value.replace(/\s+/g, " ").trim();
  if (label.length === 0) {
    return null;
  }
  if (label.length <= MAX_CALLOUT_CHARS) {
    return label;
  }
  const withoutParenthetical = label.replace(/\s*\([^()]*\)\s*$/, "").trim();
  if (withoutParenthetical.length > 0 && withoutParenthetical.length <= MAX_CALLOUT_CHARS) {
    return withoutParenthetical;
  }
  return null;
}

export function planShots(profile: ProductProfile, opts: PlanOptions): ShotList {
  const primaryMedia = opts.primaryMediaId ?? "source_1";
  const mediaFor = (angle: string): string =>
    opts.mediaIdsByAngle?.[angle] ?? primaryMedia;
  /** The one selection rule (Update.md 2.11), shared with the runner and the estimate. */
  const specSelected = (specId: string): boolean => isSpecSelected(opts.channels, specId);
  /** True when the seller picked any spec of this family. Family specific
   * shots (A+ banners, the Shopify hero, the pin) are only considered then,
   * so a pack for other channels does not list them as left out. */
  const familyPicked = (family: string): boolean =>
    listSpecs().some((spec) => familyOf(spec.id) === family && specSelected(spec.id));
  const undeliverable = new Set<ShotMethod>(opts.undeliverableMethods ?? []);

  const output = opts.output;
  const keptIds = new Set(output?.keepMediaIds ?? []);
  const offTypes = sellerOffShotTypes(output);
  const bundleOff = bundleOffShotTypes(output);
  const maxSecondary = output ? bundleMaxSecondary(bundleOf(output)) : null;
  let secondaries = 0;
  /** True when the bundle leaves this shot out: a type outside it, or an
   * other angle image past its maxSecondary. */
  const outsideBundle = (shot: Pick<Shot, "type" | "priority">): boolean =>
    bundleOff.has(shot.type) || (maxSecondary !== null && isSecondaryShot(shot) && secondaries >= maxSecondary);

  const shots: Shot[] = [];
  const skipped: SkippedShot[] = [];
  let seq = 0;
  const nextId = (type: string): string => `s${String(++seq).padStart(2, "0")}_${type}`;
  /** Records a shot the plan leaves out. An undeliverable method wins over
   * the given reason, and the bundle wins over the rest: a shot the seller's
   * set leaves out never asks for a photo or a plan. */
  const skip = (type: string, method: ShotMethod, reason: string): void => {
    const [base, angle] = type.split(":");
    const shotType = Shot.shape.type.safeParse(base);
    const inBundle =
      !shotType.success ||
      !outsideBundle({ type: shotType.data, priority: angle === undefined || angle === "front" ? 1 : 2 });
    skipped.push({
      type,
      reason: undeliverable.has(method) ? UNDELIVERABLE_METHOD_REASON : inBundle ? reason : BUNDLE_OFF_REASON,
    });
  };
  /**
   * Plans a shot on the specs the seller picked, or skips it: when its method
   * cannot ship, when the seller picked none of its specs ("channel not
   * selected"), when the shot has no spec at all (`noChannelReason`), or when
   * its extra family is off (SELLER_OFF_REASON, with the picked specs it
   * would have served).
   */
  const plan = (shot: Omit<Shot, "id">, noChannelReason: string = NO_COMPATIBLE_CHANNEL_REASON): void => {
    if (undeliverable.has(shot.method)) {
      skipped.push({ type: shot.type, reason: UNDELIVERABLE_METHOD_REASON });
      return;
    }
    if (shot.channels.length === 0) {
      skipped.push({ type: shot.type, reason: noChannelReason });
      return;
    }
    const channels = [...new Set(shot.channels.filter(specSelected))];
    if (channels.length === 0) {
      skipped.push({ type: shot.type, reason: CHANNEL_NOT_SELECTED_REASON });
      return;
    }
    if (outsideBundle(shot)) {
      skipped.push({ type: shot.type, reason: BUNDLE_OFF_REASON, channels });
      return;
    }
    if (offTypes.has(shot.type)) {
      skipped.push({ type: shot.type, reason: SELLER_OFF_REASON, channels });
      return;
    }
    if (isSecondaryShot(shot)) {
      secondaries += 1;
    }
    shots.push({ id: nextId(shot.type), ...shot, channels });
  };

  const gallery = GALLERY_SLOTS.filter((slot) => specSelected(slot.specId));
  /** Selected listing specs that take this kind of image. */
  const galleryFor = (kind: PlannedImageKind): string[] =>
    gallery
      .filter((slot) => (kind !== "generated" || slot.generated) && specAcceptsImage(getSpec(slot.specId), kind))
      .map((slot) => slot.specId);
  /** Plans a listing gallery shot. With no listing spec picked it is not
   * selected; with some picked that refuse this kind of image, no channel
   * takes it. */
  const planGallery = (shot: Omit<Shot, "id" | "channels">, kind: PlannedImageKind): void =>
    plan(
      { ...shot, channels: galleryFor(kind) },
      gallery.length === 0 ? CHANNEL_NOT_SELECTED_REASON : NO_COMPATIBLE_CHANNEL_REASON,
    );

  const angles = profile.photographedAngles;
  const reflective = profile.surface.reflective || profile.surface.transparent;
  // Rule 5: reflective or transparent products use soft even light.
  const basePreset = reflective ? "minimal_studio" : presetForCategory(profile.category);
  // Rule 4: footwear main image is a single shoe angled left.
  const footwear = profile.category === "footwear";
  const frontUsable = angles.includes("front") && profile.imageQuality.usableForMain;
  // Marketplaces whose first listing image is the white front image, and
  // Google's main slot, which takes the same image. One shot serves them
  // all and is charged once.
  const whiteFrontLeads = [
    ...gallery.filter((slot) => slot.leadsWithWhiteFront).map((slot) => slot.specId),
    ...(specSelected(GOOGLE_MAIN_SPEC) ? [GOOGLE_MAIN_SPEC] : []),
  ].filter((specId) => specAcceptsImage(getSpec(specId), "white"));
  // A kept front photo ships as itself wherever a spec takes it, so the white
  // front image is made only for the picked specs that require white.
  const frontMedia = mediaFor("front");
  const frontKept = keptIds.has(frontMedia);
  const whiteLeads = frontKept
    ? whiteFrontLeads.filter((specId) => requiresWhiteBackground(getSpec(specId)))
    : whiteFrontLeads;

  // Rule 1: always amazon_main when amazon.main is selected, from the
  // sharpest front photo, method deterministic. The same white front image
  // leads the other selected marketplaces' listings and fills Google's main
  // slot, and is charged once.
  if (specSelected(AMAZON_MAIN_SPEC)) {
    if (frontUsable) {
      plan({
        type: "amazon_main",
        sourceMediaId: mediaFor("front"),
        method: "deterministic",
        channels: [AMAZON_MAIN_SPEC, ...whiteLeads],
        stylePreset: "none",
        ...(footwear ? { scene: "single shoe angled left" } : {}),
        credits: creditCosts.deterministic,
        priority: 1,
      });
    } else {
      skip("amazon_main", "deterministic", "needs photo");
    }
  } else if (whiteLeads.length > 0) {
    if (frontUsable) {
      plan({
        type: "alt_angle_white",
        sourceMediaId: mediaFor("front"),
        method: "deterministic",
        channels: whiteLeads,
        stylePreset: "none",
        scene: footwear ? "single shoe angled left" : "front angle on white",
        credits: creditCosts.deterministic,
        priority: 1,
      });
    } else {
      skip("alt_angle_white:front", "deterministic", "needs photo");
    }
  }

  // Each kept photo ships as itself: one original_photo, charged once however
  // many specs it serves. The front photo takes every picked spec that
  // accepts a kept photo; the others take the listing gallery only. Planned
  // whatever usableForMain says, since it is the seller's own photo.
  const originalSpecs = listSpecs()
    .filter((spec) => ORIGINAL_TARGET_SPECS.has(spec.id) && specAcceptsImage(spec, "original"))
    .map((spec) => spec.id);
  for (const photo of keptPhotosOf(output)) {
    const front = photo.id === frontMedia;
    plan(
      {
        type: "original_photo",
        sourceMediaId: photo.id,
        method: "deterministic",
        channels: front ? originalSpecs : galleryFor("original"),
        stylePreset: "none",
        credits: creditCosts.deterministic,
        priority: front ? 1 : 2,
      },
      gallery.length === 0 ? CHANNEL_NOT_SELECTED_REASON : NO_COMPATIBLE_CHANNEL_REASON,
    );
  }

  // Default pack: alt_angle_white for each photographed angle. A kept photo
  // gets one only for the picked white required gallery specs (Walmart and
  // TikTok Shop today), where it cannot ship as itself.
  const whiteGallery = new Set(whiteRequiredGallerySpecIds());
  for (const angle of angles) {
    if (angle === "front") {
      continue;
    }
    if (keptIds.has(mediaFor(angle))) {
      const channels = galleryFor("white").filter((specId) => whiteGallery.has(specId));
      if (channels.length > 0) {
        plan({
          type: "alt_angle_white",
          sourceMediaId: mediaFor(angle),
          method: "deterministic",
          channels,
          stylePreset: "none",
          scene: `${angle} angle on white`,
          credits: creditCosts.deterministic,
          priority: 2,
        });
      }
      continue;
    }
    planGallery(
      {
        type: "alt_angle_white",
        sourceMediaId: mediaFor(angle),
        method: "deterministic",
        stylePreset: "none",
        scene: `${angle} angle on white`,
        credits: creditCosts.deterministic,
        priority: 2,
      },
      "white",
    );
  }
  // Rule 2: never plan an angle that was not photographed.
  for (const missing of profile.missingAnglesNeeded) {
    skip(`alt_angle_white:${missing}`, "deterministic", "needs photo");
  }

  planGallery(
    {
      type: "cutout_png",
      sourceMediaId: mediaFor("front"),
      method: "deterministic",
      stylePreset: "none",
      credits: creditCosts.deterministic,
      priority: 2,
    },
    "transparent",
  );
  planGallery(
    {
      type: "sweep_gray",
      sourceMediaId: mediaFor("front"),
      method: "deterministic",
      stylePreset: "minimal_studio",
      credits: creditCosts.deterministic,
      priority: 3,
    },
    "colored",
  );
  planGallery(
    {
      type: "sweep_brand",
      sourceMediaId: mediaFor("front"),
      method: "deterministic",
      stylePreset: "minimal_studio",
      credits: creditCosts.deterministic,
      priority: 3,
    },
    "colored",
  );

  // Exactly the pack's scene count (seed default 3, the seller's Number of
  // scenes in P1), category scenes first, then useContexts.
  const lifestyleScenes = lifestyleScenesFor(profile, sceneCountOf(output));
  for (const scene of lifestyleScenes) {
    planGallery(
      {
        type: "lifestyle",
        sourceMediaId: mediaFor("front"),
        method: "composite_generate",
        stylePreset: basePreset,
        scene,
        credits: creditCosts.generativeStill,
        priority: 4,
      },
      "generated",
    );
  }

  // Infographic with 3 to 5 callouts from benefits.
  const callouts = profile.benefits.slice(0, 5).map((b) => b.slice(0, 40));
  if (profile.category === "electronics" && callouts.length < 5) {
    // Rule 4: electronics adds ports detail callouts.
    callouts.push("ports and connectivity");
  }
  if (callouts.length > 0) {
    planGallery(
      {
        type: "infographic",
        sourceMediaId: mediaFor("front"),
        method: "template",
        stylePreset: "none",
        callouts: callouts.slice(0, 5),
        credits: creditCosts.deterministic,
        priority: 4,
      },
      "text",
    );
  } else {
    skip("infographic", "template", "no benefits to call out");
  }

  // dimensions only if dimensions exist.
  // Only a measurement the seller gave or the packaging shows is printed; a
  // model guess never ships as a fact on a charged image.
  const dimensionsLabel = profile.dimensions ? printableDimensions(profile.dimensions.value) : null;
  if (profile.dimensions && profile.dimensions.source !== "unknown" && dimensionsLabel) {
    planGallery(
      {
        type: "dimensions",
        sourceMediaId: mediaFor("front"),
        method: "template",
        stylePreset: "none",
        // The template draws this label beside the product and trims it at a
        // word boundary; a label that cannot fit goes to needs review.
        callouts: [dimensionsLabel],
        credits: creditCosts.deterministic,
        priority: 5,
      },
      "text",
    );
  } else if (profile.dimensions && profile.dimensions.source !== "unknown") {
    skip("dimensions", "template", "the dimensions are too long to print on the image");
  } else {
    skip(
      "dimensions",
      "template",
      profile.dimensions ? "dimensions not confirmed by the seller or packaging" : "no dimensions provided",
    );
  }

  // in_the_box only if the seller listed contents, comparison only if the
  // seller supplied comparison facts. Only the seller's own lines are
  // printed; a model never writes a claim onto these images.
  const boxLines = printableSellerLines(opts.boxContents);
  if (opts.hasBoxContents || boxLines.length > 0) {
    planGallery(
      {
        type: "in_the_box",
        sourceMediaId: mediaFor("packaging"),
        method: "template",
        stylePreset: "none",
        ...(boxLines.length > 0 ? { callouts: boxLines } : {}),
        credits: creditCosts.deterministic,
        priority: 5,
      },
      "text",
    );
  } else {
    skip("in_the_box", "template", NO_BOX_CONTENTS_REASON);
  }

  const comparisonLines = printableSellerLines(opts.comparisonFacts);
  if (opts.hasComparisonFacts || comparisonLines.length > 0) {
    planGallery(
      {
        type: "comparison",
        sourceMediaId: mediaFor("front"),
        method: "template",
        stylePreset: "none",
        ...(comparisonLines.length > 0 ? { callouts: comparisonLines } : {}),
        credits: creditCosts.deterministic,
        priority: 6,
      },
      "text",
    );
  } else {
    skip("comparison", "template", NO_COMPARISON_FACTS_REASON);
  }

  if (familyPicked("amazon")) {
    const planBanner = (): void =>
      plan({
        type: "aplus_banner",
        sourceMediaId: mediaFor("front"),
        method: "template",
        channels: [AMAZON_APLUS_SPEC],
        stylePreset: basePreset,
        credits: creditCosts.deterministic,
        priority: 6,
      });
    // The hero banner leads the A+ page, then the modules the product's
    // facts and the seller's input support (PHASE_16 workstream 2), then the
    // second banner, which the page's module cap drops first.
    planBanner();
    const endorsements = printableEndorsements(opts.endorsements);
    const hasEndorsements = opts.hasEndorsements === true || endorsements.length > 0;
    for (const type of Object.keys(aplusModules) as AplusModuleKey[]) {
      const seed: AplusModuleSeed = aplusModules[type];
      // A module is only considered when its A+ spec is picked, so a pack
      // for the main image alone does not list six modules as left out.
      if (!specSelected(seed.specId)) {
        continue;
      }
      const reason = moduleSkipReason(type, profile, hasEndorsements);
      if (reason) {
        skip(type, "template", reason);
        continue;
      }
      const lines = plannedModuleLines(type, profile, endorsements);
      plan({
        type,
        sourceMediaId: mediaFor("front"),
        method: "template",
        channels: [seed.specId],
        stylePreset: basePreset,
        ...(lines.length > 0 ? { callouts: lines } : {}),
        credits: creditCosts.deterministic,
        priority: 6,
      });
    }
    planBanner();
  }
  if (familyPicked("shopify")) {
    plan({
      type: "shopify_hero",
      sourceMediaId: mediaFor("front"),
      method: "composite_generate",
      channels: [SHOPIFY_HERO_SPEC],
      stylePreset: basePreset,
      credits: creditCosts.generativeStill,
      priority: 6,
    });
    // A kept front photo already covers shopify.product as itself.
    if (!frontKept) {
      plan({
        type: "collection_thumb",
        sourceMediaId: mediaFor("front"),
        method: "deterministic",
        channels: [SHOPIFY_PRODUCT_SPEC],
        stylePreset: "none",
        credits: creditCosts.deterministic,
        priority: 6,
      });
    }
  }

  for (const social of ["social_1x1", "social_4x5", "social_9x16"] as const) {
    plan({
      type: social,
      sourceMediaId: mediaFor("front"),
      method: "template",
      channels: socialChannelFor(social),
      stylePreset: basePreset,
      credits: creditCosts.deterministic,
      priority: 7,
    });
  }
  // Pinterest: one 2:3 pin, the social crop template at the pin size.
  if (familyPicked("pinterest") && hasSpec(PINTEREST_PIN_SPEC)) {
    plan({
      type: "social_2x3",
      sourceMediaId: mediaFor("front"),
      method: "template",
      channels: [PINTEREST_PIN_SPEC],
      stylePreset: basePreset,
      credits: creditCosts.deterministic,
      priority: 7,
    });
  }

  // video_spin if 4 or more angles or a video exist.
  if (angles.length >= 4 || opts.hasVideoSource) {
    plan({
      type: "video_spin",
      sourceMediaId: primaryMedia,
      method: "video_generate",
      channels: ["video.amazon_listing"],
      stylePreset: "none",
      credits: creditCosts.templatedVideo,
      priority: 8,
    });
  } else {
    skip("video_spin", "video_generate", "needs photo");
  }

  // Generative video from Growth up; UGC and long lifestyle video only on Pro
  // or Agency. Tier gates come from the seed entitlements (rule 2).
  if (isEntitled(opts.tier, "generativeVideo")) {
    plan({
      type: "video_hero_6s",
      sourceMediaId: primaryMedia,
      method: "video_generate",
      channels: ["video.social_9x16"],
      stylePreset: basePreset,
      credits: creditCosts.generativeVideoPerSecondLite * VIDEO_SECONDS.video_hero_6s,
      priority: 9,
    });
  } else {
    skip("video_hero_6s", "video_generate", "not included in this plan tier");
  }
  if (isEntitled(opts.tier, "lifestyleVideo")) {
    plan({
      type: "video_lifestyle_15s",
      sourceMediaId: primaryMedia,
      method: "video_generate",
      channels: ["video.social_9x16"],
      stylePreset: basePreset,
      credits: creditCosts.generativeVideoPerSecondLite * VIDEO_SECONDS.video_lifestyle_15s,
      priority: 10,
    });
  } else {
    skip("video_lifestyle_15s", "video_generate", "Pro or Agency only");
  }
  if (isEntitled(opts.tier, "ugcAds")) {
    plan({
      type: "video_ugc_hook",
      sourceMediaId: primaryMedia,
      method: "avatar",
      channels: ["video.social_9x16"],
      stylePreset: "none",
      credits: creditCosts.ugcAvatarAd,
      priority: 10,
    });
  } else {
    skip("video_ugc_hook", "avatar", "Pro or Agency only");
  }

  // Kept photos too small for a spec, or with added text on a spec that
  // refuses it, leave that spec, then a spec emptied only by the seller's
  // switches gets the front image, before the limits and the trim see the
  // plan.
  const sized = applyAddedOverlays(applyOriginalSizes(capAplusModules(shots, skipped), output, skipped), output, skipped);
  const covered = coverSellerOffSpecs(sized, skipped, output, { frontMediaId: frontMedia, frontUsable });

  // Channel file limits (amazon.secondary takes 8, amazon.main takes 1) and
  // rule 6, the credit budget, which keeps a file for every picked spec it
  // can afford (trimToBudget).
  // Scene variations (PHASE_16 workstream 6): each lifestyle shot carries
  // the seller's version count and its extra versions' credits, so the trim
  // and the estimate see what the pack makes. It still takes one slot.
  const kept = fitLimitsAndBudget(
    applyVariations(covered, output),
    opts.creditBudget,
    skipped,
    specSelected,
    reservedSlotsFor(covered, sceneCountOf(output)),
  );

  // Schema cap: at most 40 shots.
  while (kept.length > 40) {
    const dropped = kept.pop()!;
    skipped.push({ type: dropped.type, reason: "shot cap" });
  }

  return ShotList.parse({ shots: kept, skipped });
}

/**
 * Applies the channel file limits, then trims to the budget, and repeats
 * while a trim removed a shot: a shot trimmed for budget may have held a slot
 * on a full channel (a lifestyle scene on amazon.secondary), and a shot that
 * lost that slot can then take it. Every pass removes at least one shot, so
 * this ends. Limits run before the trim so the credits they free can keep
 * other shots. Returns the kept shots in plan order.
 */
function fitLimitsAndBudget(
  candidates: readonly Shot[],
  budget: number,
  skipped: ShotList["skipped"],
  isSelected: (specId: string) => boolean,
  reservations: ReadonlyArray<{ type: Shot["type"]; count: number }>,
): Shot[] {
  const trimmedRecords: ShotList["skipped"] = [];
  let pool = [...candidates];
  for (;;) {
    const limitRecords: ShotList["skipped"] = [];
    const capped = capShotsPerChannel(pool, limitRecords, reservations);
    const trimRecords: ShotList["skipped"] = [];
    const kept = trimToBudget(capped, budget, trimRecords, isSelected);
    if (kept.length === capped.length) {
      skipped.push(...trimmedRecords, ...limitRecords);
      return kept;
    }
    trimmedRecords.push(...trimRecords);
    const keptIds = new Set(kept.map((s) => s.id));
    const trimmedIds = new Set(capped.filter((s) => !keptIds.has(s.id)).map((s) => s.id));
    pool = pool.filter((s) => !trimmedIds.has(s.id));
  }
}

/** Reason recorded in skipped for a shot every one of whose channels was full. */
export const CHANNEL_LIMIT_REASON = "channel image limit";

/**
 * Founder decision (Phase 10 batch 1 fixes, reversible): when a listing spec
 * with several slots has more candidate shots than slots (amazon.secondary
 * takes 8), these shot types keep slots first, best priority first, and the
 * remaining slots then go by priority. Without this, white alternate angles,
 * the cutout and the sweeps (priority 2 and 3) fill all 8 Amazon slots and a
 * seller with many photographed angles gets no lifestyle scene and no
 * infographic, against the default pack of CURVI_BUILD_PLAN.md section 5.3.
 * A spec that takes a single file (amazon.main) keeps its best shot. The
 * lifestyle reservation is the pack's scene count (seed default here;
 * reservedSlotsFor takes the seller's).
 */
export const RESERVED_GALLERY_SLOTS: ReadonlyArray<{ type: Shot["type"]; count: number }> = [
  { type: "lifestyle", count: sceneCountOptions.default },
  { type: "infographic", count: 1 },
];

/**
 * The channel file limit reservations for a plan: the lifestyle reservation
 * is the pack's scene count (PHASE_15 P1), and when the plan holds kept
 * photos each one keeps a slot ahead of the others, so the seller's own
 * photos keep amazon.secondary before generated extras (PHASE_15 item 3).
 * The runner passes the same reservations to capShotsPerChannel.
 */
export function reservedSlotsFor(
  shots: readonly Shot[],
  sceneCount: number = sceneCountOptions.default,
): ReadonlyArray<{ type: Shot["type"]; count: number }> {
  const gallery = RESERVED_GALLERY_SLOTS.map((slot) => (slot.type === "lifestyle" ? { ...slot, count: sceneCount } : slot));
  const originals = shots.filter((shot) => shot.type === "original_photo").length;
  return originals > 0 ? [{ type: "original_photo", count: originals }, ...gallery] : gallery;
}

/** Reason recorded for a lifestyle scene past the pack's scene count. */
export const SCENE_COUNT_REASON = "more scenes than the pack's scene count";

/**
 * Keeps at most the pack's scene count of lifestyle shots (sceneCountOf the
 * flags: the seller's Number of scenes, else the seed default), in plan
 * order, and records the rest with SCENE_COUNT_REASON. For plans this
 * planner did not make (the fitted LLM plan), so a plan holds and makes
 * exactly what the estimate held. Returns the other shots untouched.
 */
export function capSceneCount(
  shots: readonly Shot[],
  flags: Pick<OutputPlanFlags, "sceneCount"> | undefined,
  skipped: SkippedShot[],
): Shot[] {
  const limit = sceneCountOf(flags);
  let scenes = 0;
  const out: Shot[] = [];
  for (const shot of shots) {
    if (shot.type === "lifestyle" && ++scenes > limit) {
      skipped.push({ type: shot.type, reason: SCENE_COUNT_REASON });
      continue;
    }
    out.push(shot);
  }
  return out;
}

/**
 * Specs a kept front photo may ship on: the still image specs this planner
 * makes files for. Video specs and specs no pack fills yet (the A+ premium
 * module) are left out.
 */
const ORIGINAL_TARGET_SPECS: ReadonlySet<string> = new Set([
  AMAZON_MAIN_SPEC,
  GOOGLE_MAIN_SPEC,
  AMAZON_APLUS_SPEC,
  SHOPIFY_HERO_SPEC,
  SHOPIFY_PRODUCT_SPEC,
  PINTEREST_PIN_SPEC,
  ...GALLERY_SLOTS.map((slot) => slot.specId),
  ...socialChannelFor("social_1x1"),
  ...socialChannelFor("social_4x5"),
  ...socialChannelFor("social_9x16"),
]);

/**
 * The kept photos in photo order: every photo in keepMediaIds, with its size
 * when the flags carry one. keepMediaIds is authoritative, so a kept id the
 * photo list misses is still planned, without a size.
 */
export function keptPhotosOf(flags: OutputPlanFlags | undefined): PlanPhoto[] {
  if (!flags) {
    return [];
  }
  const kept = new Set(flags.keepMediaIds);
  const listed = flags.photos.filter((photo) => kept.has(photo.id));
  const unlisted = [...kept].filter((id) => !flags.photos.some((photo) => photo.id === id)).map((id) => ({ id }));
  return [...listed, ...unlisted];
}

/** The shot types in extra families the seller turned off. Empty without flags. */
export function sellerOffShotTypes(flags: OutputPlanFlags | undefined): Set<Shot["type"]> {
  const off = new Set<Shot["type"]>();
  if (!flags) {
    return off;
  }
  for (const type of Shot.shape.type.options) {
    const family = extraFamilyOf(type);
    if (family !== null && !flags.extras[family]) {
      off.add(type);
    }
  }
  return off;
}

/** The shot types outside the pack's bundle (PHASE_16). Empty without flags
 * and for today's pack. */
export function bundleOffShotTypes(flags: Pick<OutputPlanFlags, "bundle"> | undefined): Set<Shot["type"]> {
  const inBundle = bundleShotTypes(bundleOf(flags));
  return new Set(Shot.shape.type.options.filter((type) => !inBundle.has(type)));
}

/**
 * Removes the shots the pack's bundle leaves out (PHASE_16 workstream 1):
 * every shot of a type outside the bundle, then every other angle image
 * (isSecondaryShot) past the bundle's maxSecondary, in plan order. Each is
 * recorded with BUNDLE_OFF_REASON and the specs it targeted; seller off
 * cover never fills those specs, since the seller picked a smaller set. For
 * plans this planner did not make; skipSellerOffShots runs it first, so the
 * runner's fitShotsToChannels applies it too. Returns the other shots in order.
 */
export function skipBundleOffShots(
  shots: readonly Shot[],
  flags: Pick<OutputPlanFlags, "bundle"> | undefined,
  skipped: SkippedShot[],
): Shot[] {
  const off = bundleOffShotTypes(flags);
  const maxSecondary = bundleMaxSecondary(bundleOf(flags));
  if (off.size === 0 && maxSecondary === null) {
    return [...shots];
  }
  let secondaries = 0;
  const out: Shot[] = [];
  for (const shot of shots) {
    const pastCap = maxSecondary !== null && isSecondaryShot(shot) && secondaries >= maxSecondary;
    if (off.has(shot.type) || pastCap) {
      skipped.push({ type: shot.type, reason: BUNDLE_OFF_REASON, channels: [...new Set(shot.channels)] });
      continue;
    }
    if (isSecondaryShot(shot)) {
      secondaries += 1;
    }
    out.push(shot);
  }
  return out;
}

/**
 * Removes the shots the pack's bundle leaves out (skipBundleOffShots), then
 * the shots in extra families the seller turned off, recording each of those
 * with SELLER_OFF_REASON and the specs it targeted, so coverSellerOffSpecs
 * can fill a spec left empty. For plans this planner did not make (the
 * fitted LLM plan): the runner calls it before the channel limits, as
 * fitShotsToChannels' excludeTypes step. Returns the other shots in order.
 */
export function skipSellerOffShots(
  shots: readonly Shot[],
  flags: OutputPlanFlags | undefined,
  skipped: SkippedShot[],
): Shot[] {
  const inBundle = skipBundleOffShots(shots, flags, skipped);
  const off = sellerOffShotTypes(flags);
  if (off.size === 0) {
    return inBundle;
  }
  const out: Shot[] = [];
  for (const shot of inBundle) {
    if (off.has(shot.type)) {
      skipped.push({ type: shot.type, reason: SELLER_OFF_REASON, channels: [...new Set(shot.channels)] });
    } else {
      out.push(shot);
    }
  }
  return out;
}

/** The skipped type recorded for a kept photo left off one spec: too small
 * for it, or flagged with added text it refuses (applyAddedOverlays). */
export function originalTooSmallType(specId: string): string {
  return `original_photo:${specId}`;
}

/**
 * Leaves each original_photo off the specs its photo cannot reach within the
 * enlarge cap (originalScale), recording `original_photo:{specId}` with
 * SOURCE_TOO_SMALL_REASON per spec. A photo of unknown size is assumed to
 * fit. An original left with no spec is dropped; its per spec records say
 * why. Runs before seller off cover, the channel limits and the trim.
 * Returns the shots in order; other shot types pass through untouched.
 */
export function applyOriginalSizes(
  shots: readonly Shot[],
  flags: OutputPlanFlags | undefined,
  skipped: SkippedShot[],
): Shot[] {
  if (!flags) {
    return [...shots];
  }
  const photos = new Map(flags.photos.map((photo) => [photo.id, photo]));
  const out: Shot[] = [];
  for (const shot of shots) {
    const photo = shot.type === "original_photo" ? photos.get(shot.sourceMediaId) : undefined;
    if (!photo || photo.width === undefined || photo.height === undefined) {
      out.push(shot);
      continue;
    }
    const size = { width: photo.width, height: photo.height };
    const channels = shot.channels.filter((specId) => {
      if (!hasSpec(specId) || !originalScale(size, getSpec(specId), flags).skip) {
        return true;
      }
      skipped.push({ type: originalTooSmallType(specId), reason: SOURCE_TOO_SMALL_REASON });
      return false;
    });
    if (channels.length > 0) {
      out.push(channels.length === shot.channels.length ? shot : { ...shot, channels });
    }
  }
  return out;
}

/**
 * Leaves each original_photo whose photo intake flagged with addedOverlays
 * (text, borders, watermarks or stickers added on top) off every spec that
 * refuses added text or overlays (refusesOverlays: eBay, Google), recording
 * `original_photo:{specId}` with ADDED_OVERLAYS_REASON per spec. The per
 * spec type is the too small one, so seller off cover never fills the spec
 * with the same photo. An original left with no spec is dropped. Runs next to
 * applyOriginalSizes. Pure: returns a new list; other shot types and
 * unflagged photos pass through untouched.
 */
export function applyAddedOverlays(
  shots: readonly Shot[],
  flags: OutputPlanFlags | undefined,
  skipped: SkippedShot[],
): Shot[] {
  const flagged = new Set(flags?.photos.filter((photo) => photo.addedOverlays === true).map((photo) => photo.id));
  if (flagged.size === 0) {
    return [...shots];
  }
  const out: Shot[] = [];
  for (const shot of shots) {
    if (shot.type !== "original_photo" || !flagged.has(shot.sourceMediaId)) {
      out.push(shot);
      continue;
    }
    const channels = shot.channels.filter((specId) => {
      if (!hasSpec(specId) || !refusesOverlays(getSpec(specId))) {
        return true;
      }
      skipped.push({ type: originalTooSmallType(specId), reason: ADDED_OVERLAYS_REASON });
      return false;
    });
    if (channels.length > 0) {
      out.push(channels.length === shot.channels.length ? shot : { ...shot, channels });
    }
  }
  return out;
}

export interface SellerOffCoverContext {
  /** The front photo's media id: the source of an added front image. */
  frontMediaId?: string;
  /** The front photo can lead a listing (photographed and usableForMain). */
  frontUsable: boolean;
}

/** The specs a skipped entry names: its channels, or the spec of a too small original. */
function specsOfSkipped(entry: SkippedShot): string[] {
  if (entry.channels) {
    return entry.channels;
  }
  const prefix = originalTooSmallType("");
  return entry.type.startsWith(prefix) ? [entry.type.slice(prefix.length)] : [];
}

/**
 * Seller off cover (PHASE_15 control 5): a picked spec whose every candidate
 * shot the seller turned off gets the front image instead, so turning off
 * cards never leaves meta.feed_4x5 without a file.
 * - Only specs named by a SELLER_OFF_REASON entry are covered, and never one
 *   another skipped entry names (a too small kept photo) or one a shot
 *   already targets. A spec empty for any other reason stays empty.
 * - Never a white required spec.
 * - The spec first joins the existing front shot whose image it accepts
 *   (amazon_main, the priority 1 alt_angle_white, then the front
 *   original_photo) at no extra cost. Only when none exists, and the front
 *   photo is usable, one front alt_angle_white on the chosen color is added
 *   at creditCosts.deterministic for every spec still empty.
 * Pure: returns a new list and never changes the shots it was given. The
 * planner calls it before the channel limits; the runner calls it inside
 * fitShotsToChannels next to the Google main fill.
 */
export function coverSellerOffSpecs(
  shots: readonly Shot[],
  skipped: readonly SkippedShot[],
  flags: OutputPlanFlags | undefined,
  context: SellerOffCoverContext,
): Shot[] {
  const out = [...shots];
  if (!flags) {
    return out;
  }
  const offSpecs: string[] = [];
  const otherSpecs = new Set<string>();
  for (const entry of skipped) {
    for (const specId of specsOfSkipped(entry)) {
      if (entry.reason === SELLER_OFF_REASON) {
        if (!offSpecs.includes(specId)) offSpecs.push(specId);
      } else {
        otherSpecs.add(specId);
      }
    }
  }
  const targeted = new Set(out.flatMap((shot) => shot.channels));
  const empty = offSpecs.filter(
    (specId) =>
      !targeted.has(specId) && !otherSpecs.has(specId) && hasSpec(specId) && !requiresWhiteBackground(getSpec(specId)),
  );
  const frontShotFor = (specId: string): number => {
    const spec = getSpec(specId);
    const white = specAcceptsImage(spec, "white");
    const byType = [
      out.findIndex((shot) => white && shot.type === "amazon_main"),
      out.findIndex((shot) => white && shot.type === "alt_angle_white" && shot.priority === 1),
      out.findIndex(
        (shot) =>
          shot.type === "original_photo" &&
          shot.sourceMediaId === context.frontMediaId &&
          specAcceptsImage(spec, "original"),
      ),
    ];
    return byType.find((index) => index >= 0) ?? -1;
  };
  const unfilled: string[] = [];
  for (const specId of empty) {
    const index = frontShotFor(specId);
    if (index >= 0) {
      out[index] = { ...out[index], channels: [...out[index].channels, specId] };
    } else if (specAcceptsImage(getSpec(specId), "white")) {
      unfilled.push(specId);
    }
  }
  if (unfilled.length > 0 && context.frontUsable && context.frontMediaId) {
    out.push({
      id: nextShotId(out, "alt_angle_white"),
      type: "alt_angle_white",
      sourceMediaId: context.frontMediaId,
      method: "deterministic",
      channels: unfilled,
      stylePreset: "none",
      scene: "front angle on white",
      credits: creditCosts.deterministic,
      priority: 1,
    });
  }
  return out;
}

/** An id after the planner's numbered ids ("s12_type"), unique in the list. */
function nextShotId(shots: readonly Shot[], type: string): string {
  let seq = 0;
  for (const shot of shots) {
    const match = /^s(\d+)_/.exec(shot.id);
    if (match) seq = Math.max(seq, Number(match[1]));
  }
  let id = `s${String(seq + 1).padStart(2, "0")}_${type}`;
  for (let n = 2; shots.some((shot) => shot.id === id); n++) {
    id = `s${String(seq + 1).padStart(2, "0")}_${type}_${n}`;
  }
  return id;
}

export interface ChannelLimitViolation {
  specId: string;
  /** Shots that target this spec. */
  count: number;
  /** Most files one product may have for it (channelFileLimit). */
  limit: number;
}

function fileLimitFor(specId: string): number | null {
  return hasSpec(specId) ? channelFileLimit(getSpec(specId)) : null;
}

/**
 * Channel specs a shot list targets more often than the spec allows, for
 * example a second amazon.main or a ninth amazon.secondary. Plan validators
 * (the LLM shot list check) reject a list with any violation.
 */
export function channelLimitViolations(shots: readonly Shot[]): ChannelLimitViolation[] {
  const counts = new Map<string, number>();
  for (const shot of shots) {
    for (const specId of new Set(shot.channels)) {
      counts.set(specId, (counts.get(specId) ?? 0) + 1);
    }
  }
  const violations: ChannelLimitViolation[] = [];
  for (const [specId, count] of counts) {
    const limit = fileLimitFor(specId);
    if (limit !== null && count > limit) {
      violations.push({ specId, count, limit });
    }
  }
  return violations;
}

/**
 * Keep at most each spec's file limit of shots on that spec. On a spec with
 * more than one slot, the reserved shot types (RESERVED_GALLERY_SLOTS) take
 * their slots first; every other slot goes best priority first (lower number
 * wins, plan order breaks ties). An extra shot loses only the full channel
 * and keeps the others it targets; a shot left with no channel at all moves
 * to skipped with CHANNEL_LIMIT_REASON. Returns the kept shots in their
 * original order.
 */
export function capShotsPerChannel(
  shots: readonly Shot[],
  skipped: ShotList["skipped"],
  reservations: ReadonlyArray<{ type: Shot["type"]; count: number }> = RESERVED_GALLERY_SLOTS,
): Shot[] {
  const ranked = shots
    .map((shot, index) => ({ shot, index }))
    .sort((a, b) => a.shot.priority - b.shot.priority || a.index - b.index);
  // Candidate shot indexes per spec, best first.
  const candidatesBySpec = new Map<string, number[]>();
  for (const { shot, index } of ranked) {
    for (const specId of new Set(shot.channels)) {
      const list = candidatesBySpec.get(specId) ?? [];
      list.push(index);
      candidatesBySpec.set(specId, list);
    }
  }
  // Per spec over its limit, the shot indexes that keep it.
  const keptBySpec = new Map<string, Set<number>>();
  for (const [specId, candidates] of candidatesBySpec) {
    const limit = fileLimitFor(specId);
    if (limit === null || candidates.length <= limit) {
      continue;
    }
    const keep = new Set<number>();
    if (limit > 1) {
      for (const reservation of reservations) {
        let taken = 0;
        for (const index of candidates) {
          if (keep.size >= limit || taken >= reservation.count) break;
          if (shots[index].type === reservation.type && !keep.has(index)) {
            keep.add(index);
            taken += 1;
          }
        }
      }
    }
    for (const index of candidates) {
      if (keep.size >= limit) break;
      keep.add(index);
    }
    keptBySpec.set(specId, keep);
  }

  const out: Shot[] = [];
  shots.forEach((shot, index) => {
    const kept = [...new Set(shot.channels)].filter((specId) => keptBySpec.get(specId)?.has(index) ?? true);
    if (kept.length === 0) {
      skipped.push({ type: shot.type, reason: CHANNEL_LIMIT_REASON });
      return;
    }
    out.push(kept.length === shot.channels.length ? shot : { ...shot, channels: kept });
  });
  return out;
}

/**
 * Rule 6 with channel coverage (Update.md 2.11): drops shots until the total
 * fits the budget, without leaving a picked spec empty while a file for it
 * fits. First one shot per picked spec is protected, best priority first
 * (lower number wins, then the cheaper shot, then plan order), as long as
 * the protected shots fit the budget together; a spec whose only shots do
 * not fit goes without. Then shots are dropped in this order: shots that
 * target no selected spec (recorded as CHANNEL_NOT_SELECTED_REASON, since
 * they would never ship), then unprotected shots, lowest priority (the
 * largest number) first and, among ties, the most expensive, so a single
 * drop frees the most budget; among full ties the later shot in plan order
 * goes first, so the seller's first use contexts keep their scenes. Without
 * the protection a product photographed from many angles spends the reserved
 * budget on extra gallery images and leaves a picked social crop with no
 * file. The planner and the runner share this trim. Returns the kept shots
 * in plan order.
 */
export function trimToBudget(
  shots: readonly Shot[],
  budget: number,
  skipped: ShotList["skipped"],
  isSelected: (specId: string) => boolean = () => true,
): Shot[] {
  const targetsSelected = (shot: Shot): boolean => shot.channels.some(isSelected);
  const total = (list: readonly Shot[]): number => list.reduce((sum, s) => sum + s.credits, 0);
  const kept = [...shots];
  if (total(kept) <= budget) {
    return kept;
  }

  const protectedShots = new Set<Shot>();
  const covered = new Set<string>();
  let protectedCredits = 0;
  const byValue = shots
    .map((shot, index) => ({ shot, index }))
    .sort((a, b) => a.shot.priority - b.shot.priority || a.shot.credits - b.shot.credits || a.index - b.index);
  for (const { shot } of byValue) {
    const opensSpec = shot.channels.some((c) => isSelected(c) && !covered.has(c));
    if (opensSpec && protectedCredits + shot.credits <= budget) {
      protectedShots.add(shot);
      protectedCredits += shot.credits;
      for (const c of shot.channels) {
        if (isSelected(c)) covered.add(c);
      }
    }
  }

  // The lower rank is dropped first: not selected, then unprotected, then
  // protected (never reached, since the protected shots fit the budget).
  const rank = (shot: Shot): number => (!targetsSelected(shot) ? 0 : protectedShots.has(shot) ? 2 : 1);
  while (kept.length > 0 && total(kept) > budget) {
    let dropIdx = 0;
    for (let i = 1; i < kept.length; i++) {
      const a = kept[i];
      const b = kept[dropIdx];
      const byRank = rank(b) - rank(a);
      const byPriority = a.priority - b.priority;
      if (byRank > 0 || (byRank === 0 && (byPriority > 0 || (byPriority === 0 && a.credits >= b.credits)))) {
        dropIdx = i;
      }
    }
    const [dropped] = kept.splice(dropIdx, 1);
    skipped.push({
      type: dropped.type,
      reason: targetsSelected(dropped) ? CREDIT_BUDGET_REASON : CHANNEL_NOT_SELECTED_REASON,
    });
  }
  return kept;
}

function socialChannelFor(type: "social_1x1" | "social_4x5" | "social_9x16"): string[] {
  switch (type) {
    case "social_1x1":
      return ["meta.feed_1x1"];
    case "social_4x5":
      return ["meta.feed_4x5"];
    case "social_9x16":
      return ["meta.story_9x16"];
  }
}

function presetForCategory(category: ProductProfile["category"]): string {
  switch (category) {
    case "food_beverage":
    case "home_kitchen":
      return "kitchen_lifestyle";
    case "sports_outdoor":
    case "pet":
      return "outdoor";
    case "jewelry":
    case "beauty":
      return "luxury_marble";
    default:
      return "minimal_studio";
  }
}

/**
 * Exactly n lifestyle scenes (PHASE_15 P1 "Number of scenes", n within seed
 * sceneCountOptions), for every category: the rule 4 category scenes first
 * (Update.md 2.16: they always keep their slots, where apparel once returned
 * early and 4 or more contexts cut them), then the seller's use contexts,
 * deduped, then seed lifestyleFallbackScenes until n. The scenes keep
 * today's order: contexts first, then the category scenes, so the budget
 * trim, which drops the later scene first, keeps the seller's first
 * contexts.
 */
export function lifestyleScenesFor(profile: ProductProfile, n: number = sceneCountOptions.default): string[] {
  const count = Math.max(sceneCountOptions.min, Math.min(sceneCountOptions.max, Math.floor(n)));
  let contexts = profile.useContexts;
  const required: string[] = [];
  // Rule 4 category additions.
  switch (profile.category) {
    case "apparel":
      // On model only when the seller supplied on model photos; otherwise
      // flat lay scenes plus ghost style from the supplied photos.
      if (!profile.photographedAngles.includes("in_use" as Angle)) {
        contexts = contexts.map((s) => `flat lay, ${s}`);
        required.push("ghost style from supplied photos");
      }
      break;
    case "jewelry":
      required.push("detail macro", "scale on hand");
      break;
    case "food_beverage":
      required.push("serving scene");
      break;
    case "furniture":
      required.push("room scale scene");
      break;
    case "electronics":
      required.push("ports detail");
      break;
  }
  const kept = required.slice(0, count);
  const contextSlots = count - kept.length;
  const chosen = [...new Set(contexts)].filter((s) => !kept.includes(s)).slice(0, contextSlots);
  const scenes = [...chosen, ...kept];
  for (const fallback of lifestyleFallbackScenes) {
    if (scenes.length >= count) break;
    if (!scenes.includes(fallback)) {
      scenes.push(fallback);
    }
  }
  return scenes.slice(0, count);
}
