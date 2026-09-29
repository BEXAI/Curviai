/**
 * Planning the ads formats (PHASE_16 workstream 3): the moodboard pin, the
 * carousel and the static ad pack, in the Extra images family `ads` (off
 * unless the seller turns it on). Pure: the deterministic planner calls
 * planAdsShots with its own plan and skip hooks, so the ads formats follow
 * the same channel selection, bundle and seller switch rules as every
 * other shot.
 *
 * Words: only lines the planner can stand behind are printed. Headlines come
 * from the product's name, benefits and features (the analyzer's words),
 * each through rule 9 lint and the A+ claims guard (no figure and no claim
 * word the seller did not type); calls to action are the seed's plain
 * phrases. Credits follow founder decision 4: template slides and ads at
 * creditCosts.deterministic, and with scenes on a carousel pays one
 * creditCosts.generativeStill for its one scene layer, on its first slide.
 */
import { adTextLimit, getSpec, hasSpec } from "@curvi/specs";
import { guardedLine, type ClaimsContext } from "../aplus-copy";
import { specAcceptsImage } from "../output-options";
import type { ProductProfile, Shot, ShotMethod } from "../schemas";
import { creditCosts } from "../seed/credits";
import { adsFormats } from "../seed/templates";
import { printableSellerLines } from "../seller-inputs";
import { carouselGeometry, carouselPlacementsValid, type CarouselSlideRole } from "../templates/ads-layout";

/** Reason recorded when the product gives too few lines we can stand behind. */
export const ADS_NO_COPY_REASON = "not enough copy we could stand behind";

/** Reason recorded for a carousel with fewer slides than the seed minimum. */
export const CAROUSEL_TOO_SHORT_REASON = "not enough to fill a carousel";

/** Reason recorded for a carousel whose layout would cut a product at a seam. */
export const CAROUSEL_SEAM_REASON = "a product would cross a slide edge";

/** Reason recorded for every slide of a carousel that lost one of its slides
 * to a channel limit or the credit budget: a carousel ships whole or not at all. */
export const CAROUSEL_INCOMPLETE_REASON = "the carousel could not be made whole";

/** Reason recorded for an ad placement with too few headlines that fit its text limit. */
export const AD_PLACEMENT_SHORT_REASON = "too few headlines fit this placement's text limit";

/** The one carousel a pack makes today. */
export const CAROUSEL_ID = "c1";

/** A planned shot before the planner numbers it. */
export type PlannedAdsShot = Omit<Shot, "id">;

export interface AdsPlanContext {
  profile: ProductProfile;
  /** True when the seller picked this spec. */
  specSelected: (specId: string) => boolean;
  /** Scenes are on (the scenes Extra images switch), so the pin and the
   * carousel get a generated scene layer where the spec takes one. */
  scenesOn: boolean;
  frontMediaId: string;
  stylePreset: string;
  /** What the seller typed (box contents, comparison facts, quotes), for
   * the claims guard and the carousel's in the box slide. */
  boxContents?: readonly string[];
  sellerText: readonly string[];
}

export interface AdsPlanHooks {
  plan: (shot: PlannedAdsShot) => void;
  skip: (type: string, method: ShotMethod, reason: string) => void;
}

function uniqueLines(raw: readonly string[], maxChars: number, ctx: ClaimsContext): string[] {
  const out: string[] = [];
  for (const line of raw) {
    const clean = guardedLine(line, maxChars, ctx);
    if (clean !== null && !out.some((kept) => kept.toLowerCase() === clean.toLowerCase())) {
      out.push(clean);
    }
  }
  return out;
}

/**
 * Headlines the planner may print, in order: the product's name, then its
 * benefits, then its features, each rule 9 clean, at most the seeded 40
 * characters, and through the claims guard. Duplicates dropped.
 */
export function adHeadlines(
  profile: Pick<ProductProfile, "name" | "benefits" | "features">,
  sellerText: readonly string[],
): string[] {
  return uniqueLines([profile.name, ...profile.benefits, ...profile.features], adsFormats.lineMaxChars, {
    sellerText,
  });
}

/** One slide of the planned story: its beat, how large the product is, and its words. */
export interface CarouselSlidePlan {
  beat: (typeof adsFormats.carousel.beats)[number];
  role: CarouselSlideRole;
  headline?: string;
  callouts?: string[];
  cta?: string;
}

/**
 * The carousel's story (seed adsFormats.carousel): a hook with the product's
 * name, one slide per benefit, the details (features), in the box (only the
 * seller's lines) and the call to action. Empty when fewer than minSlides
 * slides have words to show; never more than maxSlides.
 */
export function carouselStory(ctx: Pick<AdsPlanContext, "profile" | "boxContents" | "sellerText">): CarouselSlidePlan[] {
  const seed = adsFormats.carousel;
  const guard: ClaimsContext = { sellerText: ctx.sellerText };
  const [name] = uniqueLines([ctx.profile.name], adsFormats.lineMaxChars, guard);
  const benefits = uniqueLines(ctx.profile.benefits, adsFormats.lineMaxChars, guard).slice(0, seed.maxBenefitSlides);
  const features = uniqueLines(ctx.profile.features, adsFormats.lineMaxChars, guard).slice(0, seed.maxDetailLines);
  const box = printableSellerLines(ctx.boxContents);
  const hookLine = name ?? benefits[0];
  if (!hookLine) {
    return [];
  }
  const slides: CarouselSlidePlan[] = [];
  for (const beat of seed.beats) {
    switch (beat) {
      case "hook":
        slides.push({ beat, role: "hero", headline: hookLine });
        break;
      case "benefit":
        for (const benefit of benefits.filter((b) => b !== hookLine)) {
          slides.push({ beat, role: "support", headline: benefit });
        }
        break;
      case "details":
        if (features.length > 0) {
          slides.push({ beat, role: "support", callouts: features });
        }
        break;
      case "in_the_box":
        if (box.length > 0) {
          slides.push({ beat, role: "support", callouts: box.slice(0, seed.maxDetailLines) });
        }
        break;
      case "cta":
        slides.push({ beat, role: "hero", headline: hookLine, cta: seed.callToAction });
        break;
    }
  }
  if (slides.length < seed.minSlides) {
    return [];
  }
  // Keep the call to action last when the story runs long.
  return slides.length <= seed.maxSlides ? slides : [...slides.slice(0, seed.maxSlides - 1), slides[slides.length - 1]!];
}

/**
 * The ad pack's variants per picked placement: the headlines that fit each
 * placement's registry text limit (and the seeded 40 characters), each
 * paired with the seed call to action at its index. A placement with fewer
 * than minVariants usable headlines gets none.
 */
export function adPackPlan(
  headlines: readonly string[],
  placements: readonly string[],
): { variants: Array<{ variantKey: string; headline: string; cta: string; channels: string[] }>; short: string[] } {
  const seed = adsFormats.adPack;
  const fitsBy = new Map<string, string[]>();
  const short: string[] = [];
  for (const specId of placements) {
    const limit = adTextLimit(getSpec(specId)) ?? adsFormats.lineMaxChars;
    const fits = headlines.filter((h) => h.length <= limit).slice(0, seed.maxVariants);
    if (fits.length < seed.minVariants) {
      short.push(specId);
    } else {
      fitsBy.set(specId, fits);
    }
  }
  const order = [...new Set([...fitsBy.values()].flat())].sort((a, b) => headlines.indexOf(a) - headlines.indexOf(b));
  const variants = order.slice(0, seed.maxVariants).map((headline, i) => ({
    variantKey: `v${i + 1}`,
    headline,
    cta: seed.callsToAction[i % seed.callsToAction.length]!,
    channels: placements.filter((specId) => fitsBy.get(specId)?.includes(headline)),
  }));
  return { variants: variants.filter((v) => v.channels.length > 0), short };
}

/**
 * Plans the ads formats for the picked specs. Call only when the ads switch
 * is on: with it off the planner considers none of them, so a pack's
 * skipped list, plan and hold are exactly as before the family existed.
 */
export function planAdsShots(ctx: AdsPlanContext, hooks: AdsPlanHooks): void {
  const { profile, specSelected } = ctx;
  const sellerText = ctx.sellerText;
  const headlines = adHeadlines(profile, sellerText);
  const base = { sourceMediaId: ctx.frontMediaId, stylePreset: ctx.stylePreset } as const;

  // Moodboard pin: the product, its scene when scenes are on, one line.
  const pinSpec = adsFormats.pin.specId;
  if (hasSpec(pinSpec) && specSelected(pinSpec)) {
    const generated = ctx.scenesOn && specAcceptsImage(getSpec(pinSpec), "generated");
    const method: ShotMethod = generated ? "composite_generate" : "template";
    const [headline] = headlines;
    if (headline) {
      hooks.plan({
        ...base,
        type: "pin_moodboard",
        method,
        channels: [pinSpec],
        headline,
        ...(generated ? { scene: `${profile.useContexts[0] ?? "styled moodboard"} scene` } : {}),
        credits: generated ? creditCosts.generativeStill : creditCosts.deterministic,
        priority: 7,
      });
    } else {
      hooks.skip("pin_moodboard", method, ADS_NO_COPY_REASON);
    }
  }

  // Carousel: one canvas cut into slides; one scene layer when scenes are on.
  const carouselSpec = adsFormats.carousel.specId;
  if (hasSpec(carouselSpec) && specSelected(carouselSpec)) {
    const generated = ctx.scenesOn && specAcceptsImage(getSpec(carouselSpec), "generated");
    const method: ShotMethod = generated ? "composite_generate" : "template";
    const story = carouselStory(ctx);
    if (story.length === 0) {
      hooks.skip("carousel_slide", method, CAROUSEL_TOO_SHORT_REASON);
    } else if (
      !carouselPlacementsValid(
        carouselGeometry(getSpec(carouselSpec), story.length),
        story.map((slide) => slide.role),
      )
    ) {
      hooks.skip("carousel_slide", method, CAROUSEL_SEAM_REASON);
    } else {
      story.forEach((slide, i) => {
        hooks.plan({
          ...base,
          type: "carousel_slide",
          method,
          channels: [carouselSpec],
          carouselId: CAROUSEL_ID,
          slideIndex: i + 1,
          slideCount: story.length,
          ...(slide.headline ? { headline: slide.headline } : {}),
          ...(slide.callouts ? { callouts: slide.callouts } : {}),
          ...(slide.cta ? { cta: slide.cta } : {}),
          ...(generated ? { scene: `${profile.useContexts[0] ?? "styled lifestyle"} scene` } : {}),
          // Founder decision 4: one scene layer per carousel, on its first
          // slide; template slides at the deterministic price each.
          credits: generated ? (i === 0 ? creditCosts.generativeStill : 0) : creditCosts.deterministic,
          priority: 7,
        });
      });
    }
  }

  // Ad pack: 4 to 6 variants, each rendered for every picked placement.
  const placements = adsFormats.adPack.placements.filter((specId) => hasSpec(specId) && specSelected(specId));
  if (placements.length > 0) {
    const { variants, short } = adPackPlan(headlines, placements);
    for (const specId of short) {
      hooks.skip(`ad_variant:${specId}`, "template", AD_PLACEMENT_SHORT_REASON);
    }
    if (variants.length === 0 && short.length === 0) {
      hooks.skip("ad_variant", "template", ADS_NO_COPY_REASON);
    }
    for (const variant of variants) {
      hooks.plan({
        ...base,
        type: "ad_variant",
        method: "template",
        channels: variant.channels,
        variantKey: variant.variantKey,
        headline: variant.headline,
        cta: variant.cta,
        credits: creditCosts.deterministic,
        priority: 8,
      });
    }
  }
}

/**
 * A carousel ships whole or not at all: every slide of a carousel that lost
 * a slide (to a channel limit, the budget or anything else between planning
 * and now) is removed and recorded with CAROUSEL_INCOMPLETE_REASON. Pure;
 * other shots pass through in order.
 */
export function dropIncompleteCarousels<T extends Pick<Shot, "type" | "carouselId" | "slideIndex" | "slideCount">>(
  shots: readonly T[],
  skipped: Array<{ type: string; reason: string }>,
): T[] {
  const present = new Map<string, Set<number>>();
  const expected = new Map<string, number>();
  for (const shot of shots) {
    if (shot.type !== "carousel_slide" || !shot.carouselId) continue;
    const set = present.get(shot.carouselId) ?? new Set<number>();
    set.add(shot.slideIndex ?? 0);
    present.set(shot.carouselId, set);
    expected.set(shot.carouselId, shot.slideCount ?? 0);
  }
  const broken = new Set<string>();
  for (const [id, slides] of present) {
    const count = expected.get(id) ?? 0;
    const whole = count > 0 && slides.size === count && [...slides].every((i) => i >= 1 && i <= count);
    if (!whole) broken.add(id);
  }
  if (broken.size === 0) {
    return [...shots];
  }
  return shots.filter((shot) => {
    if (shot.type === "carousel_slide" && shot.carouselId && broken.has(shot.carouselId)) {
      skipped.push({ type: shot.type, reason: CAROUSEL_INCOMPLETE_REASON });
      return false;
    }
    return true;
  });
}

/** The words the seller typed, for the claims guard: box contents, comparison facts, quotes. */
export function sellerTextFor(parts: ReadonlyArray<readonly string[] | undefined>): string[] {
  return parts.flatMap((lines) => [...(lines ?? [])]);
}
