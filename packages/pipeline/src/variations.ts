/**
 * Scene variations (docs/phases/PHASE_16.md workstream 6, founder decision
 * 3). The seller asks for up to variationOptions.max versions of each
 * lifestyle scene and picks which ones ship.
 *
 * Two steps, both pure and client safe:
 * - applyVariations marks each planned lifestyle shot with the count and
 *   adds the extra versions to its credits, so the plan, the estimate, the
 *   hold and the budget trim all see what the pack will make. The shot
 *   still takes one slot per channel, since only picked versions ship.
 * - expandVariations, at run time, turns a marked shot back into the scene
 *   itself (its normal price) plus one shot per extra version, each charged
 *   at creditCosts.generativeStill. Every version is its own generation of
 *   the same scene around the same real product: the same composite, the
 *   same fidelity gate (rule 3). The runner packages only the scene itself;
 *   the extra versions are stored unpicked until the seller picks them.
 */
import { DEFAULT_VARIATIONS, variationsOf } from "./output-options";
import type { Shot } from "./schemas";
import { creditCosts } from "./seed/credits";
import { variationOptions } from "./seed/variations";

/** Shot types that take scene variations. */
export const VARIATION_SHOT_TYPES: ReadonlySet<Shot["type"]> = new Set<Shot["type"]>(["lifestyle"]);

/** True when a shot of this type may be made in several versions. */
export function takesVariations(type: Shot["type"]): boolean {
  return VARIATION_SHOT_TYPES.has(type);
}

/** Credits the extra versions of one scene cost: every version past the
 * first at creditCosts.generativeStill (founder decision 3, rule 2). */
export function extraVariationCredits(variations: number): number {
  const count = clampVariations(variations);
  return (count - 1) * creditCosts.generativeStill;
}

function clampVariations(n: number): number {
  if (!Number.isFinite(n)) {
    return DEFAULT_VARIATIONS;
  }
  return Math.max(variationOptions.min, Math.min(variationOptions.max, Math.floor(n)));
}

/**
 * Marks every lifestyle shot with the pack's variation count (variationsOf
 * the flags) and adds the extra versions to its credits. A shot already
 * marked keeps its mark, so applying twice changes nothing. With the
 * default of one the shots come back untouched.
 */
export function applyVariations(shots: readonly Shot[], flags: { variations?: number } | null | undefined): Shot[] {
  const count = clampVariations(variationsOf(flags));
  if (count <= DEFAULT_VARIATIONS) {
    return [...shots];
  }
  return shots.map((shot) =>
    takesVariations(shot.type) && shot.variations === undefined && shot.variation === undefined
      ? { ...shot, variations: count, credits: shot.credits + extraVariationCredits(count) }
      : shot,
  );
}

/** The shot id of an extra version: the scene's id with ".v" and the version. */
export function variationShotId(shotId: string, variation: number): string {
  return `${shotId}.v${variation}`;
}

const VARIATION_ID = /^(.+)\.v(\d+)$/;

/** The scene's shot id and the version for an extra version's shot id, or
 * null for any other shot id. */
export function parseVariationShotId(shotId: string): { baseShotId: string; variation: number } | null {
  const match = VARIATION_ID.exec(shotId);
  if (!match) {
    return null;
  }
  const variation = Number(match[2]);
  if (variation <= variationOptions.min || variation > variationOptions.max) {
    return null;
  }
  return { baseShotId: match[1], variation };
}

/** True for a shot expandVariations added (an extra version). */
export function isExtraVariation(shot: Pick<Shot, "variation">): boolean {
  return shot.variation !== undefined;
}

/**
 * Turns every marked shot into the scene itself (unmarked, back at its own
 * price) followed by one shot per extra version, each with its own id, its
 * version number and creditCosts.generativeStill as its credits. The total
 * credits never change: what the plan held is exactly what the versions
 * cost. Unmarked shots pass through.
 */
export function expandVariations(shots: readonly Shot[]): Shot[] {
  const out: Shot[] = [];
  for (const shot of shots) {
    if (shot.variations === undefined) {
      out.push(shot);
      continue;
    }
    const count = clampVariations(shot.variations);
    const { variations: _count, ...rest } = shot;
    const base: Shot = { ...rest, credits: shot.credits - extraVariationCredits(count) };
    out.push(base);
    for (let variation = variationOptions.min + 1; variation <= count; variation++) {
      out.push({
        ...base,
        id: variationShotId(shot.id, variation),
        variation,
        credits: creditCosts.generativeStill,
      });
    }
  }
  return out;
}
