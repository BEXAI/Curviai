/**
 * Deterministic demo shot plan: the deterministic planner's plan for the
 * product the pack estimate is built around (lib/pack-estimate.ts), so a
 * demo pack plans exactly what production's estimate holds, selected by
 * channel spec with the same rule as the runner. Built from the sharp free
 * planner subpath only; shot shapes validate against the Shot schema and
 * every credit figure comes from the seed credit table. The real pipeline
 * planner takes over in db mode workers.
 */

import { Shot, ShotList } from "@curvi/pipeline/schemas";
import { isShotMethodDeliverable, type TierKey } from "@curvi/pipeline/seed";
import type { AngleRole } from "@curvi/pipeline/seller-inputs";
import { referencePackShots, type EstimateSellerInputs } from "@/lib/pack-estimate";

export const DEMO_SOURCE_MEDIA_ID = "demo_source_1";

/** Concept packs leave marketplace channels out before planning, exactly as
 * the runner does (plan 2.7): synthetic renders never go to a marketplace.
 * Video and avatar shots follow the same seed gates as production: the plan
 * must include the feature (the planner checks isEntitled) and the method
 * must ship today (isShotMethodDeliverable, the list the db runtime skips and
 * pack estimates leave out). While video is coming soon no demo pack plans
 * or holds credits for it. Seller inputs add what they add in production:
 * photo roles add angles, and box contents and comparison facts add the
 * in_the_box and comparison images. */
export function planDemoShots(
  requestedChannels: string[],
  tier: TierKey,
  mode: "listing" | "concept" = "listing",
  seller: {
    angles?: AngleRole[];
    boxContents?: string[];
    comparisonFacts?: string[];
    /** The pack's output options as estimate inputs (outputEstimateInputs),
     * the same ones the form and createJob pass, so the three agree. */
    output?: Pick<EstimateSellerInputs, "output" | "photos" | "colorHex">;
  } = {},
): Shot[] {
  const shots = referencePackShots(requestedChannels, mode, tier, DEMO_SOURCE_MEDIA_ID, {
    angles: seller.angles,
    hasBoxContents: (seller.boxContents?.length ?? 0) > 0,
    hasComparisonFacts: (seller.comparisonFacts?.length ?? 0) > 0,
    ...(seller.output ?? {}),
  }).filter((shot) => isShotMethodDeliverable(shot.method));
  // Validate against the source of truth schema before handing the plan out.
  return ShotList.parse({ shots, skipped: [] }).shots;
}
