/**
 * Rule based fallback shot planner. Pure code over ProductProfile implementing
 * the shot_planner rules from CURVI_BUILD_PLAN.md section 5.3: used in demo
 * mode and tests when no LLM is available. Output validates against ShotList.
 */
import { channelFileLimit, getSpec, hasSpec } from "@curvi/specs";
import { creditCosts, isEntitled, type TierKey } from "../seed/credits";
import { ProductProfile, Shot, ShotList } from "../schemas";

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
}

type Angle = ProductProfile["photographedAngles"][number];

const VIDEO_SECONDS = { video_hero_6s: 6, video_lifestyle_15s: 15 } as const;

export function planShots(profile: ProductProfile, opts: PlanOptions): ShotList {
  const primaryMedia = opts.primaryMediaId ?? "source_1";
  const mediaFor = (angle: string): string =>
    opts.mediaIdsByAngle?.[angle] ?? primaryMedia;
  const selected = (family: string): boolean =>
    opts.channels.some((c) => c === family || c.startsWith(`${family}.`));

  const shots: Shot[] = [];
  const skipped: ShotList["skipped"] = [];
  let seq = 0;
  const nextId = (type: string): string => `s${String(++seq).padStart(2, "0")}_${type}`;
  const angles = profile.photographedAngles;
  const reflective = profile.surface.reflective || profile.surface.transparent;
  // Rule 5: reflective or transparent products use soft even light.
  const basePreset = reflective ? "minimal_studio" : presetForCategory(profile.category);

  // Rule 1: always amazon_main when Amazon is selected, from the sharpest
  // front photo, method deterministic.
  if (selected("amazon")) {
    if (angles.includes("front") && profile.imageQuality.usableForMain) {
      shots.push({
        id: nextId("amazon_main"),
        type: "amazon_main",
        sourceMediaId: mediaFor("front"),
        method: "deterministic",
        channels: ["amazon.main"],
        stylePreset: "none",
        // Rule 4: footwear main image is a single shoe angled left.
        ...(profile.category === "footwear" ? { scene: "single shoe angled left" } : {}),
        credits: creditCosts.deterministic,
        priority: 1,
      });
    } else {
      skipped.push({ type: "amazon_main", reason: "needs photo" });
    }
  }

  // Default pack: alt_angle_white for each photographed angle.
  for (const angle of angles) {
    if (angle === "front") {
      continue;
    }
    shots.push({
      id: nextId("alt_angle_white"),
      type: "alt_angle_white",
      sourceMediaId: mediaFor(angle),
      method: "deterministic",
      channels: secondaryChannels(selected),
      stylePreset: "none",
      scene: `${angle} angle on white`,
      credits: creditCosts.deterministic,
      priority: 2,
    });
  }
  // Rule 2: never plan an angle that was not photographed.
  for (const missing of profile.missingAnglesNeeded) {
    skipped.push({ type: `alt_angle_white:${missing}`, reason: "needs photo" });
  }

  shots.push({
    id: nextId("cutout_png"),
    type: "cutout_png",
    sourceMediaId: mediaFor("front"),
    method: "deterministic",
    channels: secondaryChannels(selected),
    stylePreset: "none",
    credits: creditCosts.deterministic,
    priority: 2,
  });
  shots.push({
    id: nextId("sweep_gray"),
    type: "sweep_gray",
    sourceMediaId: mediaFor("front"),
    method: "deterministic",
    channels: secondaryChannels(selected),
    stylePreset: "minimal_studio",
    credits: creditCosts.deterministic,
    priority: 3,
  });
  shots.push({
    id: nextId("sweep_brand"),
    type: "sweep_brand",
    sourceMediaId: mediaFor("front"),
    method: "deterministic",
    channels: secondaryChannels(selected),
    stylePreset: "minimal_studio",
    credits: creditCosts.deterministic,
    priority: 3,
  });

  // 2 to 4 lifestyle scenes matched to useContexts.
  const lifestyleScenes = lifestyleScenesFor(profile);
  for (const scene of lifestyleScenes) {
    shots.push({
      id: nextId("lifestyle"),
      type: "lifestyle",
      sourceMediaId: mediaFor("front"),
      method: "composite_generate",
      channels: secondaryChannels(selected),
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
    shots.push({
      id: nextId("infographic"),
      type: "infographic",
      sourceMediaId: mediaFor("front"),
      method: "template",
      channels: secondaryChannels(selected),
      stylePreset: "none",
      callouts: callouts.slice(0, 5),
      credits: creditCosts.deterministic,
      priority: 4,
    });
  } else {
    skipped.push({ type: "infographic", reason: "no benefits to call out" });
  }

  // dimensions only if dimensions exist.
  // Only a measurement the seller gave or the packaging shows is printed; a
  // model guess never ships as a fact on a charged image.
  if (profile.dimensions && profile.dimensions.source !== "unknown") {
    shots.push({
      id: nextId("dimensions"),
      type: "dimensions",
      sourceMediaId: mediaFor("front"),
      method: "template",
      channels: secondaryChannels(selected),
      stylePreset: "none",
      // The template draws this label beside the product and trims it at a
      // word boundary; a label that cannot fit goes to needs review.
      callouts: [profile.dimensions.value],
      credits: creditCosts.deterministic,
      priority: 5,
    });
  } else {
    skipped.push({
      type: "dimensions",
      reason: profile.dimensions ? "dimensions not confirmed by the seller or packaging" : "no dimensions provided",
    });
  }

  if (opts.hasBoxContents) {
    shots.push({
      id: nextId("in_the_box"),
      type: "in_the_box",
      sourceMediaId: mediaFor("packaging"),
      method: "template",
      channels: secondaryChannels(selected),
      stylePreset: "none",
      credits: creditCosts.deterministic,
      priority: 5,
    });
  } else {
    skipped.push({ type: "in_the_box", reason: "seller did not list contents" });
  }

  if (opts.hasComparisonFacts) {
    shots.push({
      id: nextId("comparison"),
      type: "comparison",
      sourceMediaId: mediaFor("front"),
      method: "template",
      channels: secondaryChannels(selected),
      stylePreset: "none",
      credits: creditCosts.deterministic,
      priority: 6,
    });
  } else {
    skipped.push({ type: "comparison", reason: "seller did not supply comparison facts" });
  }

  if (selected("amazon")) {
    for (let i = 0; i < 2; i++) {
      shots.push({
        id: nextId("aplus_banner"),
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
    shots.push({
      id: nextId("shopify_hero"),
      type: "shopify_hero",
      sourceMediaId: mediaFor("front"),
      method: "composite_generate",
      channels: ["shopify.hero_banner"],
      stylePreset: basePreset,
      credits: creditCosts.generativeStill,
      priority: 6,
    });
    shots.push({
      id: nextId("collection_thumb"),
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
    shots.push({
      id: nextId(social),
      type: social,
      sourceMediaId: mediaFor("front"),
      method: "template",
      channels: socialChannelFor(social),
      stylePreset: basePreset,
      credits: creditCosts.deterministic,
      priority: 7,
    });
  }

  // video_spin if 4 or more angles or a video exist.
  if (angles.length >= 4 || opts.hasVideoSource) {
    shots.push({
      id: nextId("video_spin"),
      type: "video_spin",
      sourceMediaId: primaryMedia,
      method: "video_generate",
      channels: ["video.amazon_listing"],
      stylePreset: "none",
      credits: creditCosts.templatedVideo,
      priority: 8,
    });
  } else {
    skipped.push({ type: "video_spin", reason: "needs photo" });
  }

  // Generative video from Growth up; UGC and long lifestyle video only on Pro
  // or Agency. Tier gates come from the seed entitlements (rule 2).
  if (isEntitled(opts.tier, "generativeVideo")) {
    shots.push({
      id: nextId("video_hero_6s"),
      type: "video_hero_6s",
      sourceMediaId: primaryMedia,
      method: "video_generate",
      channels: ["video.social_9x16"],
      stylePreset: basePreset,
      credits: creditCosts.generativeVideoPerSecondLite * VIDEO_SECONDS.video_hero_6s,
      priority: 9,
    });
  } else {
    skipped.push({ type: "video_hero_6s", reason: "not included in this plan tier" });
  }
  if (isEntitled(opts.tier, "lifestyleVideo")) {
    shots.push({
      id: nextId("video_lifestyle_15s"),
      type: "video_lifestyle_15s",
      sourceMediaId: primaryMedia,
      method: "video_generate",
      channels: ["video.social_9x16"],
      stylePreset: basePreset,
      credits: creditCosts.generativeVideoPerSecondLite * VIDEO_SECONDS.video_lifestyle_15s,
      priority: 10,
    });
  } else {
    skipped.push({ type: "video_lifestyle_15s", reason: "Pro or Agency only" });
  }
  if (isEntitled(opts.tier, "ugcAds")) {
    shots.push({
      id: nextId("video_ugc_hook"),
      type: "video_ugc_hook",
      sourceMediaId: primaryMedia,
      method: "avatar",
      channels: ["video.social_9x16"],
      stylePreset: "none",
      credits: creditCosts.ugcAvatarAd,
      priority: 10,
    });
  } else {
    skipped.push({ type: "video_ugc_hook", reason: "Pro or Agency only" });
  }

  // Channel file limits (amazon.secondary takes 8, amazon.main takes 1):
  // extras lose that channel, and a shot left with no channel is skipped, so
  // it is neither reserved nor charged. Done before the budget trim so the
  // freed credits can keep other shots.
  const capped = capShotsPerChannel(shots, skipped);

  // Rule 6: stay within the credit budget, dropping lowest priority shots first.
  const kept = trimToBudget(capped, opts.creditBudget, skipped);

  // Schema cap: at most 40 shots.
  while (kept.length > 40) {
    const dropped = kept.pop()!;
    skipped.push({ type: dropped.type, reason: "shot cap" });
  }

  return ShotList.parse({ shots: kept, skipped });
}

/** Reason recorded in skipped for a shot every one of whose channels was full. */
export const CHANNEL_LIMIT_REASON = "channel image limit";

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
 * Keep at most each spec's file limit of shots on that spec, best priority
 * first (lower number wins, plan order breaks ties). An extra shot loses only
 * the full channel and keeps the others it targets; a shot left with no
 * channel at all moves to skipped with CHANNEL_LIMIT_REASON. Returns the
 * kept shots in their original order.
 */
export function capShotsPerChannel(shots: readonly Shot[], skipped: ShotList["skipped"]): Shot[] {
  const ranked = shots.map((shot, index) => ({ shot, index }));
  ranked.sort((a, b) => a.shot.priority - b.shot.priority || a.index - b.index);
  const used = new Map<string, number>();
  const channelsByIndex = new Map<number, string[]>();
  for (const { shot, index } of ranked) {
    const kept: string[] = [];
    for (const specId of new Set(shot.channels)) {
      const limit = fileLimitFor(specId);
      const n = used.get(specId) ?? 0;
      if (limit !== null && n >= limit) {
        continue;
      }
      used.set(specId, n + 1);
      kept.push(specId);
    }
    channelsByIndex.set(index, kept);
  }
  const out: Shot[] = [];
  shots.forEach((shot, index) => {
    const kept = channelsByIndex.get(index) ?? [];
    if (kept.length === 0) {
      skipped.push({ type: shot.type, reason: CHANNEL_LIMIT_REASON });
      return;
    }
    out.push(kept.length === shot.channels.length ? shot : { ...shot, channels: kept });
  });
  return out;
}

function trimToBudget(shots: Shot[], budget: number, skipped: ShotList["skipped"]): Shot[] {
  const kept = [...shots];
  const total = (): number => kept.reduce((sum, s) => sum + s.credits, 0);
  while (kept.length > 0 && total() > budget) {
    // Drop the lowest priority (largest number) shot; among ties, the most
    // expensive one, so a single drop frees the most budget.
    let dropIdx = 0;
    for (let i = 1; i < kept.length; i++) {
      const a = kept[i];
      const b = kept[dropIdx];
      if (a.priority > b.priority || (a.priority === b.priority && a.credits > b.credits)) {
        dropIdx = i;
      }
    }
    const [dropped] = kept.splice(dropIdx, 1);
    skipped.push({ type: dropped.type, reason: "credit budget" });
  }
  return kept;
}

function secondaryChannels(selected: (family: string) => boolean): string[] {
  const channels: string[] = [];
  if (selected("amazon")) channels.push("amazon.secondary");
  if (selected("shopify")) channels.push("shopify.product");
  if (selected("google")) channels.push("google.merchant.lifestyle");
  if (channels.length === 0) channels.push("shopify.product");
  return channels;
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
