/**
 * Pure choices for share pages: the slug, which shot is the hero "after",
 * and which delivered file shows each shot. Kept free of the database so
 * they are unit tested directly.
 */

import { randomBytes } from "node:crypto";

/** Lower case letters and digits without the look alikes 0, 1, l and o. */
const SLUG_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export const SLUG_LENGTH = 10;
const SLUG_PATTERN = new RegExp(`^[${SLUG_ALPHABET}]{${SLUG_LENGTH}}$`);

/** A random, unguessable slug: 10 characters from 32, about 50 bits. */
export function newShareSlug(): string {
  const bytes = randomBytes(SLUG_LENGTH);
  let slug = "";
  for (const byte of bytes) {
    // 256 is a multiple of 32, so the modulo adds no bias.
    slug += SLUG_ALPHABET[byte % SLUG_ALPHABET.length];
  }
  return slug;
}

/** True for a slug newShareSlug could have made. Checked before any lookup. */
export function isShareSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG_PATTERN.test(value);
}

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

/**
 * The file that shows a shot best on a web page: the most square one, then
 * the largest. No channel is named, so this follows the registry.
 */
export function pickDisplayVariant<T extends { width: number | null; height: number | null; createdAt: Date }>(
  variants: T[],
): T | null {
  if (variants.length === 0) {
    return null;
  }
  const squareness = (v: T) => (v.width && v.height ? Math.abs(Math.log(v.width / v.height)) : Number.POSITIVE_INFINITY);
  return [...variants].sort(
    (a, b) =>
      squareness(a) - squareness(b) ||
      (b.width ?? 0) - (a.width ?? 0) ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  )[0];
}

/** A readable name for a shot type, e.g. "amazon_main" to "Amazon main". */
export function shotLabel(shotType: string): string {
  const pretty = shotType.split(":")[0].replaceAll("_", " ").trim();
  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}
