/**
 * Numbers the pricing copy quotes, computed from the seed through the same
 * estimate the new pack form shows, so the page never claims a pack size the
 * product does not charge.
 */

import { estimatePackCredits } from "@/lib/pack-estimate";

/** The channels a typical first pack targets. */
export const TYPICAL_PACK_CHANNELS = ["amazon.main", "shopify.product"];

/** Credits for a listing pack of still images for one product on Amazon and
 * Shopify. Uses the starter tier so no video lines are counted: video is not
 * produced yet. */
export function stillPackCredits(): number {
  return Math.max(1, estimatePackCredits(TYPICAL_PACK_CHANNELS, "listing", "starter").total);
}

/** Roughly how many such packs a monthly allowance covers. */
export function packsPerMonth(creditsPerMonth: number): number {
  return Math.floor(creditsPerMonth / stillPackCredits());
}
