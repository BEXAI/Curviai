/**
 * Ad copy from the copy recipe (docs/phases/PHASE_16.md workstream 3: "Ad
 * copy: headline and call to action variants from the copy recipe, with
 * each platform's text limits in the registry"). Sharp free.
 *
 * The planner makes the ad variants from lines it can stand behind
 * (planner/ads.ts adHeadlines and the seed calls to action), so the plan,
 * the estimate and the hold are known before any model call. The
 * copy_generator recipe (version 3, seed adCopyRecipe) then rewords those
 * variants in the same call that writes the A+ modules. applyAdCopy only
 * replaces words: it never adds, drops or reprices a shot, and every
 * recipe line passes rule 9 lint, the claims guard and the tightest text
 * limit of the placements its variant serves. When the recipe gives too
 * few clean lines the planner's lines stay, whole.
 */
import { z } from "zod";
import { adTextLimit, getSpec, hasSpec } from "@curvi/specs";
import {
  AplusCopyResult,
  aplusCopyRequest,
  guardedLine,
  type AplusCopyRequest,
  type ClaimsContext,
} from "./aplus-copy";
import { isAplusModuleType, type ProductProfile, type Shot } from "./schemas";
import { adsFormats } from "./seed/templates";

/** The copy_generator version 3 answer, sent as its strict tool schema:
 * version 2's modules plus the ad lines. Every field is required, so a
 * pack with no modules gets an empty modules list and one with no ad
 * variants gets empty ad lists. Lengths are checked after the call. */
export const PackCopyResult = AplusCopyResult.extend({
  ads: z.object({
    headlines: z.array(z.string()),
    callsToAction: z.array(z.string()),
  }),
});
export type PackCopyResult = z.infer<typeof PackCopyResult>;

/** The ads section of the copy request: how many lines to write and the
 * character limits every line must fit. */
export interface AdCopyRequest {
  variants: number;
  /** The tightest limit among the planned variants' placements (registry
   * textLimits) and the seeded line length, so each headline fits any of them. */
  headlineMaxChars: number;
  callsToAction: number;
  ctaMaxChars: number;
}

/** The whole copy_generator version 3 request. */
export interface PackCopyRequest extends AplusCopyRequest {
  ads: AdCopyRequest | null;
}

function adVariants<T extends Pick<Shot, "type">>(shots: readonly T[]): T[] {
  return shots.filter((shot) => shot.type === "ad_variant");
}

/** The longest headline a shot can print: the seeded line length, tightened
 * by the text limit of every placement it serves. */
export function adHeadlineLimit(shot: Pick<Shot, "channels">): number {
  let limit: number = adsFormats.lineMaxChars;
  for (const specId of shot.channels) {
    const spec = hasSpec(specId) ? adTextLimit(getSpec(specId)) : null;
    if (spec !== null) {
      limit = Math.min(limit, spec);
    }
  }
  return limit;
}

/** True when the plan holds an ad variant the recipe can reword. */
export function needsAdCopy(shots: readonly Pick<Shot, "type">[]): boolean {
  return adVariants(shots).length > 0;
}

/** The ads section for the planned variants, or null when there are none. */
export function adCopyRequest(shots: readonly Pick<Shot, "type" | "channels">[]): AdCopyRequest | null {
  const variants = adVariants(shots);
  if (variants.length === 0) {
    return null;
  }
  return {
    variants: variants.length,
    headlineMaxChars: Math.min(...variants.map(adHeadlineLimit)),
    callsToAction: variants.length,
    ctaMaxChars: adsFormats.adCopy.ctaMaxChars,
  };
}

/** One request for everything the recipe writes on this plan: the A+
 * modules (as version 2) and the ad lines. */
export function packCopyRequest(
  profile: ProductProfile,
  shots: readonly Pick<Shot, "type" | "channels">[],
  wrappedUserDescription: string | null,
): PackCopyRequest {
  return {
    ...aplusCopyRequest(profile, shots.map((shot) => shot.type).filter(isAplusModuleType), wrappedUserDescription),
    ads: adCopyRequest(shots),
  };
}

function cleanLines(raw: readonly string[], maxChars: number, ctx: ClaimsContext): string[] {
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
 * Puts the recipe's ad lines on the planned ad variants. Headlines: every
 * variant takes, in plan order, the first unused recipe headline that
 * passes the guard and fits its placements; if any variant finds none,
 * every variant keeps the planner's headline, so a pack never mixes two
 * sources or repeats a line. Calls to action: at least the seeded minimum
 * of clean recipe lines replaces the seed's, cycled across the variants.
 * Other shots, and every shot's channels, credits and order, pass through
 * untouched. Pure.
 */
export function applyAdCopy<T extends Shot>(
  shots: readonly T[],
  copy: Pick<PackCopyResult, "ads"> | null,
  ctx: ClaimsContext,
): T[] {
  const variants = adVariants(shots);
  if (!copy || variants.length === 0) {
    return [...shots];
  }
  const pool = cleanLines(copy.ads.headlines, adsFormats.lineMaxChars, ctx);
  const headlineOf = new Map<T, string>();
  const used = new Set<string>();
  for (const shot of variants) {
    const limit = adHeadlineLimit(shot);
    const pick = pool.find((line) => !used.has(line) && line.length <= limit);
    if (pick === undefined) {
      headlineOf.clear();
      break;
    }
    used.add(pick);
    headlineOf.set(shot, pick);
  }
  const ctas = cleanLines(copy.ads.callsToAction, adsFormats.adCopy.ctaMaxChars, ctx);
  const useCtas = ctas.length >= adsFormats.adCopy.minCallsToAction;
  let index = 0;
  return shots.map((shot) => {
    if (shot.type !== "ad_variant") {
      return shot;
    }
    const i = index++;
    const headline = headlineOf.get(shot);
    return {
      ...shot,
      ...(headline !== undefined ? { headline } : {}),
      ...(useCtas ? { cta: ctas[i % ctas.length]! } : {}),
    };
  });
}
