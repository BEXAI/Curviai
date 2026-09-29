/**
 * Which shot is the hero "after" of a makeover, shared by share pages and
 * the job page reveal. Client safe: no node imports.
 */

/**
 * Shot types in the order the hero "after" image is chosen: a lifestyle
 * scene shows the makeover best, then the white main image, then the rest.
 * The seller's own kept photo (PHASE_15 original_photo) comes last among
 * the named types: as an "after" it shows the same photo as the "before".
 * The shot type may carry a suffix ("lifestyle:2"), which is ignored.
 */
export const HERO_ORDER = [
  "lifestyle",
  "amazon_main",
  "sweep_gray",
  "sweep_brand",
  "alt_angle_white",
  "shopify_hero",
  "social_1x1",
  "social_4x5",
  "collection_thumb",
  "original_photo",
] as const;

function baseShotType(shotType: string): string {
  return shotType.split(":")[0];
}

function heroRank(shotType: string): number {
  const index = (HERO_ORDER as readonly string[]).indexOf(baseShotType(shotType));
  return index === -1 ? HERO_ORDER.length : index;
}

/**
 * True when every hero candidate is the seller's own kept photo, so the
 * makeover hides the before and after (it would show the same photo twice)
 * and is titled "Sized for each channel" (PHASE_15 item 34). False for no
 * candidates.
 */
export function allHeroCandidatesOriginal(assets: ReadonlyArray<{ shotType: string }>): boolean {
  return assets.length > 0 && assets.every((asset) => baseShotType(asset.shotType) === "original_photo");
}

/** The asset to show as the hero, by shot type then creation order. */
export function pickHeroAsset<T extends { shotType: string; createdAt: Date }>(assets: T[]): T | null {
  if (assets.length === 0) {
    return null;
  }
  return [...assets].sort((a, b) => heroRank(a.shotType) - heroRank(b.shotType) || a.createdAt.getTime() - b.createdAt.getTime())[0];
}
