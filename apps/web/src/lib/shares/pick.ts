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

// The hero order lives in ./hero, which is client safe (this file imports
// node:crypto), so the reveal on the job page can share it.
export { allHeroCandidatesOriginal, pickHeroAsset } from "./hero";

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
