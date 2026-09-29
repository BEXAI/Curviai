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
  type ChannelSpec,
} from "@curvi/specs";
import { GALLERY_SLOTS, specAcceptsImage, type PlannedImageKind } from "../output-options";
import { creditCosts, isEntitled, type TierKey } from "../seed/credits";
import { ProductProfile, Shot, ShotList, type ShotMethod } from "../schemas";
import { printableSellerLines } from "../seller-inputs";

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

  const shots: Shot[] = [];
  const skipped: ShotList["skipped"] = [];
  let seq = 0;
  const nextId = (type: string): string => `s${String(++seq).padStart(2, "0")}_${type}`;
  /** Records a shot the plan leaves out. An undeliverable method wins over the given reason. */
  const skip = (type: string, method: ShotMethod, reason: string): void => {
    skipped.push({ type, reason: undeliverable.has(method) ? UNDELIVERABLE_METHOD_REASON : reason });
  };
  /**
   * Plans a shot on the specs the seller picked, or skips it: when its method
   * cannot ship, when the seller picked none of its specs ("channel not
   * selected"), or when the shot has no spec at all (`noChannelReason`).
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
        channels: [AMAZON_MAIN_SPEC, ...whiteFrontLeads],
        stylePreset: "none",
        ...(footwear ? { scene: "single shoe angled left" } : {}),
        credits: creditCosts.deterministic,
        priority: 1,
      });
    } else {
      skip("amazon_main", "deterministic", "needs photo");
    }
  } else if (whiteFrontLeads.length > 0) {
    if (frontUsable) {
      plan({
        type: "alt_angle_white",
        sourceMediaId: mediaFor("front"),
        method: "deterministic",
        channels: whiteFrontLeads,
        stylePreset: "none",
        scene: footwear ? "single shoe angled left" : "front angle on white",
        credits: creditCosts.deterministic,
        priority: 1,
      });
    } else {
      skip("alt_angle_white:front", "deterministic", "needs photo");
    }
  }

  // Default pack: alt_angle_white for each photographed angle.
  for (const angle of angles) {
    if (angle === "front") {
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

  // 2 to 4 lifestyle scenes matched to useContexts.
  const lifestyleScenes = lifestyleScenesFor(profile);
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
    for (let i = 0; i < 2; i++) {
      plan({
        type: "aplus_banner",
        sourceMediaId: mediaFor("front"),
        method: "template",
        channels: [AMAZON_APLUS_SPEC],
        stylePreset: basePreset,
        credits: creditCosts.deterministic,
        priority: 6,
      });
    }
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

  // Channel file limits (amazon.secondary takes 8, amazon.main takes 1) and
  // rule 6, the credit budget, which keeps a file for every picked spec it
  // can afford (trimToBudget).
  const kept = fitLimitsAndBudget(shots, opts.creditBudget, skipped, specSelected);

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
): Shot[] {
  const trimmedRecords: ShotList["skipped"] = [];
  let pool = [...candidates];
  for (;;) {
    const limitRecords: ShotList["skipped"] = [];
    const capped = capShotsPerChannel(pool, limitRecords);
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
 * A spec that takes a single file (amazon.main) keeps its best shot.
 */
export const RESERVED_GALLERY_SLOTS: ReadonlyArray<{ type: Shot["type"]; count: number }> = [
  { type: "lifestyle", count: 2 },
  { type: "infographic", count: 1 },
];

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

const MIN_LIFESTYLE_SCENES = 2;
const MAX_LIFESTYLE_SCENES = 4;
const FALLBACK_LIFESTYLE_SCENES = ["clean studio scene", "everyday use scene"];

/**
 * 2 to 4 lifestyle scenes: the seller's use contexts, plus the rule 4
 * category scenes, which always keep their slots (Update.md 2.16: apparel
 * used to return early, so it could end with one scene, and 4 or more
 * contexts cut the ghost style scene; the same cut dropped the jewelry,
 * food, furniture and electronics additions). Every category then shares the
 * dedupe and the two scene minimum.
 */
function lifestyleScenesFor(profile: ProductProfile): string[] {
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
  const contextSlots = MAX_LIFESTYLE_SCENES - required.length;
  const chosen = [...new Set(contexts)].filter((s) => !required.includes(s)).slice(0, contextSlots);
  const scenes = [...chosen, ...required];
  if (scenes.length < MIN_LIFESTYLE_SCENES) {
    for (const fallback of FALLBACK_LIFESTYLE_SCENES) {
      if (!scenes.includes(fallback)) {
        scenes.push(fallback);
      }
    }
  }
  return scenes.slice(0, MAX_LIFESTYLE_SCENES);
}
