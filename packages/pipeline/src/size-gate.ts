/**
 * Source size gate (docs/phases/PHASE_13.md item 7, checked at upload by the
 * preflight of docs/phases/PHASE_14.md workstream 4). A photo too small for
 * a channel would be upscaled past what still looks sharp, so the seller is
 * told before a pack runs, with the numbers.
 *
 * Per channel spec: a spec with a fill rule (the product must cover that
 * share of the canvas, like amazon.main) needs the product region's long
 * side to reach minLongSide times the fill minimum within MAX_SOURCE_UPSCALE;
 * a spec without one needs the whole photo's long side to reach minLongSide
 * within the same upscale. Specs with no minimum size, and video specs, are
 * never gated. The sizes come from the spec registry (CLAUDE.md rule 2).
 */
import { getSpec, hasSpec, type ChannelSpec } from "@curvi/specs";
import { minLongSideFor } from "./qc/pixelChecks";

/** The most a source is scaled up for any output (PHASE_13.md item 7). */
export const MAX_SOURCE_UPSCALE = 1.5;

/** What one channel spec asks of the photo. */
export interface SizeRequirement {
  specId: string;
  /** "product" when the product region is measured (the spec has a fill
   * rule), "photo" when the whole photo is. */
  measure: "product" | "photo";
  /** The smallest long side in source pixels the spec can be made from. */
  needs: number;
}

/** The requirement for one spec, or null when the spec sets no size a
 * source could miss (no minimum, or a video spec). */
export function sizeRequirement(spec: ChannelSpec): SizeRequirement | null {
  if (spec.fps !== undefined || spec.maxSeconds !== undefined || spec.id.startsWith("video.")) {
    return null;
  }
  const minLong = minLongSideFor(spec);
  if (minLong <= 1) {
    return null;
  }
  const fill = spec.fill?.min;
  const measure = fill !== undefined ? "product" : "photo";
  return { specId: spec.id, measure, needs: Math.ceil((minLong * (fill ?? 1)) / MAX_SOURCE_UPSCALE) };
}

/** The requirement for a spec id; null for unknown ids too. */
export function sizeRequirementFor(specId: string): SizeRequirement | null {
  return hasSpec(specId) ? sizeRequirement(getSpec(specId)) : null;
}

/** One spec's verdict for a photo. */
export interface SizeVerdict extends SizeRequirement {
  /** The measured long side in source pixels. */
  has: number;
  ok: boolean;
}

/**
 * Checks one photo against the given spec ids. photoLongSide is the upright
 * photo's long side; productLongSide the long side of the product region in
 * the same pixels, or null when unknown (the whole photo is used then).
 */
export function sizeVerdicts(
  specIds: readonly string[],
  photoLongSide: number,
  productLongSide: number | null,
): SizeVerdict[] {
  const verdicts: SizeVerdict[] = [];
  for (const id of specIds) {
    const requirement = sizeRequirementFor(id);
    if (!requirement) continue;
    const has = Math.round(requirement.measure === "product" ? (productLongSide ?? photoLongSide) : photoLongSide);
    verdicts.push({ ...requirement, has, ok: has >= requirement.needs });
  }
  return verdicts;
}
