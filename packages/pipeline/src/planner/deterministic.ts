/**
 * Rule based fallback shot planner. Pure code over ProductProfile implementing
 * the shot_planner rules from CURVI_BUILD_PLAN.md section 5.3: used in demo
 * mode and tests when no LLM is available, and whenever the LLM plan is
 * rejected. Output validates against ShotList.
 *
 * Channel routing reads each spec's rules from the registry (CLAUDE.md rule
 * 2): a shot only targets a selected spec whose background, text and
 * transparency rules its image can meet. Etsy, eBay, Walmart and TikTok Shop
 * get deterministic and template images only (a white front image first,
 * then white angles and whatever else the spec allows); Pinterest gets a 2:3
 * pin crop.
 */
import { channelFileLimit, getSpec, hasSpec, type ChannelSpec } from "@curvi/specs";
import { creditCosts, isEntitled, type TierKey } from "../seed/credits";
import { ProductProfile, Shot, ShotList, type ShotMethod } from "../schemas";

export interface PlanOptions {
  /** Selected channels or channel families, e.g. ["amazon", "shopify.product"]. */
  channels: string[];
  tier: TierKey;
  creditBudget: number;
  /** Seller listed what is in the box. */
  hasBoxContents?: boolean;
  /** Seller supplied comparison facts. */
  hasComparisonFacts?: boolean;
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

/**
 * What a planned image looks like, for matching it to a spec's rules:
 * - white: the product on pure white (main image, alternate angles).
 * - transparent: the cutout PNG, which keeps its alpha.
 * - colored: a studio sweep in a color other than white.
 * - text: a template with copy on a colored card (infographic, dimensions,
 *   in the box, comparison).
 * - generated: a composited scene from an image model.
 */
export type PlannedImageKind = "white" | "transparent" | "colored" | "text" | "generated";

interface GallerySlot {
  family: string;
  /** The spec the family's listing images ship on. */
  specId: string;
  /** Generated scenes (composite and edit methods) may ship here. The newer
   * marketplaces get deterministic and template images only. */
  generated: boolean;
  /** The listing's first image comes from this same spec, so the white front
   * image leads it. Amazon has its own amazon.main spec instead. */
  leadsWithWhiteFront: boolean;
}

/** Listing image slots per marketplace family, in plan order. */
const GALLERY_SLOTS: readonly GallerySlot[] = [
  { family: "amazon", specId: "amazon.secondary", generated: true, leadsWithWhiteFront: false },
  { family: "shopify", specId: "shopify.product", generated: true, leadsWithWhiteFront: false },
  { family: "google", specId: "google.merchant.lifestyle", generated: true, leadsWithWhiteFront: false },
  { family: "etsy", specId: "etsy.listing", generated: false, leadsWithWhiteFront: true },
  { family: "ebay", specId: "ebay.listing", generated: false, leadsWithWhiteFront: true },
  { family: "walmart", specId: "walmart.main", generated: false, leadsWithWhiteFront: true },
  { family: "tiktokshop", specId: "tiktokshop.main", generated: false, leadsWithWhiteFront: true },
];

/** When no listing family is selected, gallery shots keep this legacy target;
 * the runner then drops them as not selected before any spend. */
const NO_GALLERY_FALLBACK = "shopify.product";

const PINTEREST_PIN_SPEC = "pinterest.pin";

/** Channel family of a spec id or family string: "etsy.listing" is "etsy". */
function familyOf(channel: string): string {
  return channel.split(".")[0] ?? channel;
}

function isPureWhite(rgb: readonly number[] | undefined): boolean {
  return !!rgb && rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255;
}

/** True when the spec's background rule allows a backdrop other than white. */
function allowsColoredBackground(spec: ChannelSpec): boolean {
  const bg = spec.background?.type;
  return bg === undefined || bg === "any" || bg === "consistent";
}

/**
 * Whether an image of this kind meets the spec's registry rules. Solid white
 * and white preferred specs take only white images. Text needs textAllowed
 * and a background rule that allows the template's card color. The cutout
 * needs PNG and a background rule that keeps transparency; a spec that does
 * not would get the front photo flattened onto white again, a duplicate of
 * the white front image.
 */
export function specAcceptsImage(spec: ChannelSpec, kind: PlannedImageKind): boolean {
  const bg = spec.background;
  switch (kind) {
    case "white":
      return bg?.type !== "solid" || isPureWhite(bg.rgb);
    case "transparent":
      return (
        (!spec.formats || spec.formats.includes("png")) &&
        (bg === undefined || bg.type === "any" || bg.type === "consistent" || bg.type === "white_or_transparent")
      );
    case "colored":
    case "generated":
      return allowsColoredBackground(spec);
    case "text":
      return spec.textAllowed !== false && allowsColoredBackground(spec);
  }
}

export function planShots(profile: ProductProfile, opts: PlanOptions): ShotList {
  const primaryMedia = opts.primaryMediaId ?? "source_1";
  const mediaFor = (angle: string): string =>
    opts.mediaIdsByAngle?.[angle] ?? primaryMedia;
  const selected = (family: string): boolean =>
    opts.channels.some((c) => c === family || c.startsWith(`${family}.`));
  const undeliverable = new Set<ShotMethod>(opts.undeliverableMethods ?? []);

  const shots: Shot[] = [];
  const skipped: ShotList["skipped"] = [];
  let seq = 0;
  const nextId = (type: string): string => `s${String(++seq).padStart(2, "0")}_${type}`;
  /** Records a shot the plan leaves out. An undeliverable method wins over the given reason. */
  const skip = (type: string, method: ShotMethod, reason: string): void => {
    skipped.push({ type, reason: undeliverable.has(method) ? UNDELIVERABLE_METHOD_REASON : reason });
  };
  /** Plans a shot, or skips it when its method cannot ship or no selected spec takes it. */
  const plan = (shot: Omit<Shot, "id">): void => {
    if (undeliverable.has(shot.method)) {
      skipped.push({ type: shot.type, reason: UNDELIVERABLE_METHOD_REASON });
      return;
    }
    if (shot.channels.length === 0) {
      skipped.push({ type: shot.type, reason: NO_COMPATIBLE_CHANNEL_REASON });
      return;
    }
    shots.push({ id: nextId(shot.type), ...shot });
  };

  const gallery = GALLERY_SLOTS.filter((slot) => selected(slot.family) && hasSpec(slot.specId));
  /** Selected listing specs that take this kind of image. */
  const galleryFor = (kind: PlannedImageKind): string[] => {
    if (gallery.length === 0) {
      return [NO_GALLERY_FALLBACK];
    }
    return gallery
      .filter((slot) => (kind !== "generated" || slot.generated) && specAcceptsImage(getSpec(slot.specId), kind))
      .map((slot) => slot.specId);
  };

  const angles = profile.photographedAngles;
  const reflective = profile.surface.reflective || profile.surface.transparent;
  // Rule 5: reflective or transparent products use soft even light.
  const basePreset = reflective ? "minimal_studio" : presetForCategory(profile.category);
  // Rule 4: footwear main image is a single shoe angled left.
  const footwear = profile.category === "footwear";
  const frontUsable = angles.includes("front") && profile.imageQuality.usableForMain;
  // Marketplaces whose first listing image is the white front image.
  const whiteFrontLeads = gallery
    .filter((slot) => slot.leadsWithWhiteFront && specAcceptsImage(getSpec(slot.specId), "white"))
    .map((slot) => slot.specId);

  // Rule 1: always amazon_main when Amazon is selected, from the sharpest
  // front photo, method deterministic. The same white front image leads the
  // other selected marketplaces' listings, and is charged once.
  if (selected("amazon")) {
    if (frontUsable) {
      plan({
        type: "amazon_main",
        sourceMediaId: mediaFor("front"),
        method: "deterministic",
        channels: ["amazon.main", ...whiteFrontLeads],
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
    plan({
      type: "alt_angle_white",
      sourceMediaId: mediaFor(angle),
      method: "deterministic",
      channels: galleryFor("white"),
      stylePreset: "none",
      scene: `${angle} angle on white`,
      credits: creditCosts.deterministic,
      priority: 2,
    });
  }
  // Rule 2: never plan an angle that was not photographed.
  for (const missing of profile.missingAnglesNeeded) {
    skip(`alt_angle_white:${missing}`, "deterministic", "needs photo");
  }

  plan({
    type: "cutout_png",
    sourceMediaId: mediaFor("front"),
    method: "deterministic",
    channels: galleryFor("transparent"),
    stylePreset: "none",
    credits: creditCosts.deterministic,
    priority: 2,
  });
  plan({
    type: "sweep_gray",
    sourceMediaId: mediaFor("front"),
    method: "deterministic",
    channels: galleryFor("colored"),
    stylePreset: "minimal_studio",
    credits: creditCosts.deterministic,
    priority: 3,
  });
  plan({
    type: "sweep_brand",
    sourceMediaId: mediaFor("front"),
    method: "deterministic",
    channels: galleryFor("colored"),
    stylePreset: "minimal_studio",
    credits: creditCosts.deterministic,
    priority: 3,
  });

  // 2 to 4 lifestyle scenes matched to useContexts.
  const lifestyleScenes = lifestyleScenesFor(profile);
  for (const scene of lifestyleScenes) {
    plan({
      type: "lifestyle",
      sourceMediaId: mediaFor("front"),
      method: "composite_generate",
      channels: galleryFor("generated"),
      stylePreset: basePreset,
      scene,
      credits: creditCosts.generativeStill,
      priority: 4,
    });
  }

  // Infographic with 3 to 5 callouts from benefits.
  const callouts = profile.benefits.slice(0, 5).map((b) => b.slice(0, 40));
  if (profile.category === "electronics" && callouts.length < 5) {
    // Rule 4: electronics adds ports detail callouts.
    callouts.push("ports and connectivity");
  }
  if (callouts.length > 0) {
    plan({
      type: "infographic",
      sourceMediaId: mediaFor("front"),
      method: "template",
      channels: galleryFor("text"),
      stylePreset: "none",
      callouts: callouts.slice(0, 5),
      credits: creditCosts.deterministic,
      priority: 4,
    });
  } else {
    skip("infographic", "template", "no benefits to call out");
  }

  // dimensions only if dimensions exist.
  // Only a measurement the seller gave or the packaging shows is printed; a
  // model guess never ships as a fact on a charged image.
  if (profile.dimensions && profile.dimensions.source !== "unknown") {
    plan({
      type: "dimensions",
      sourceMediaId: mediaFor("front"),
      method: "template",
      channels: galleryFor("text"),
      stylePreset: "none",
      // The template draws this label beside the product and trims it at a
      // word boundary; a label that cannot fit goes to needs review.
      callouts: [profile.dimensions.value],
      credits: creditCosts.deterministic,
      priority: 5,
    });
  } else {
    skip(
      "dimensions",
      "template",
      profile.dimensions ? "dimensions not confirmed by the seller or packaging" : "no dimensions provided",
    );
  }

  if (opts.hasBoxContents) {
    plan({
      type: "in_the_box",
      sourceMediaId: mediaFor("packaging"),
      method: "template",
      channels: galleryFor("text"),
      stylePreset: "none",
      credits: creditCosts.deterministic,
      priority: 5,
    });
  } else {
    skip("in_the_box", "template", "seller did not list contents");
  }

  if (opts.hasComparisonFacts) {
    plan({
      type: "comparison",
      sourceMediaId: mediaFor("front"),
      method: "template",
      channels: galleryFor("text"),
      stylePreset: "none",
      credits: creditCosts.deterministic,
      priority: 6,
    });
  } else {
    skip("comparison", "template", "seller did not supply comparison facts");
  }

  if (selected("amazon")) {
    for (let i = 0; i < 2; i++) {
      plan({
        type: "aplus_banner",
        sourceMediaId: mediaFor("front"),
        method: "template",
        channels: ["amazon.aplus.basic_header"],
        stylePreset: basePreset,
        credits: creditCosts.deterministic,
        priority: 6,
      });
    }
  }
  if (selected("shopify")) {
    plan({
      type: "shopify_hero",
      sourceMediaId: mediaFor("front"),
      method: "composite_generate",
      channels: ["shopify.hero_banner"],
      stylePreset: basePreset,
      credits: creditCosts.generativeStill,
      priority: 6,
    });
    plan({
      type: "collection_thumb",
      sourceMediaId: mediaFor("front"),
      method: "deterministic",
      channels: ["shopify.product"],
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
  if (selected("pinterest") && hasSpec(PINTEREST_PIN_SPEC)) {
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
  // rule 6, the credit budget. A shot that targets no selected family (the
  // planner still proposes social crops and video for every pack; the runner
  // drops them) is trimmed first, so it never costs a shot that ships.
  const families = new Set(opts.channels.map(familyOf));
  const kept = fitLimitsAndBudget(shots, opts.creditBudget, skipped, (shot) =>
    shot.channels.some((c) => families.has(familyOf(c))),
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
  targetsSelected: (shot: Shot) => boolean,
): Shot[] {
  const trimmedRecords: ShotList["skipped"] = [];
  let pool = [...candidates];
  for (;;) {
    const limitRecords: ShotList["skipped"] = [];
    const capped = capShotsPerChannel(pool, limitRecords);
    const trimRecords: ShotList["skipped"] = [];
    const kept = trimToBudget(capped, budget, trimRecords, targetsSelected);
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
 * Drops shots until the total fits the budget. Shots that target no selected
 * family go first (recorded as CHANNEL_NOT_SELECTED_REASON, since they would
 * never ship); then the lowest priority (largest number) and, among ties,
 * the most expensive, so a single drop frees the most budget. Among full
 * ties the later shot in plan order goes first, so the seller's first use
 * contexts keep their scenes.
 */
function trimToBudget(
  shots: Shot[],
  budget: number,
  skipped: ShotList["skipped"],
  targetsSelected: (shot: Shot) => boolean,
): Shot[] {
  const kept = [...shots];
  const total = (): number => kept.reduce((sum, s) => sum + s.credits, 0);
  const rank = (shot: Shot): number => (targetsSelected(shot) ? 0 : 1);
  while (kept.length > 0 && total() > budget) {
    let dropIdx = 0;
    for (let i = 1; i < kept.length; i++) {
      const a = kept[i];
      const b = kept[dropIdx];
      const byRank = rank(a) - rank(b);
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
