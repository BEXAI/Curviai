/**
 * What the new pack form says about a photo's preflight (docs/phases/
 * PHASE_14.md workstream 4): "Found: silver watch. Ready for Amazon, Shopify
 * and Meta." or the specific problem and its fix. Pure and client safe; the
 * size numbers come from the server's size gate (PreflightView.sizes), the
 * selected channels from the form.
 */

import { specAcceptsImage } from "@curvi/pipeline/output-options";
import { getSpec, hasSpec, refusesOverlays } from "@curvi/specs";
import type { PreflightItemView, PreflightProblem, PreflightView } from "./types";

const FAMILY_NAMES: Record<string, string> = {
  amazon: "Amazon",
  shopify: "Shopify",
  meta: "Meta",
  google: "Google",
  etsy: "Etsy",
  ebay: "eBay",
  walmart: "Walmart",
  tiktokshop: "TikTok Shop",
  pinterest: "Pinterest",
  video: "Video",
};

/** The marketplace or network a channel spec belongs to. */
export function familyName(specId: string): string {
  const family = specId.split(".")[0] ?? specId;
  return FAMILY_NAMES[family] ?? family.charAt(0).toUpperCase() + family.slice(1);
}

/** "Amazon main" for amazon.main. */
export function specName(specId: string): string {
  const [family, ...rest] = specId.split(".");
  const tail = rest.join(" ").replaceAll("_", " ");
  return tail ? `${familyName(family ?? specId)} ${tail}` : familyName(specId);
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The item the pack is for: the seller's tap, else the note's pick. */
export function chosenItem(view: PreflightView, chosen: number | null | undefined): PreflightItemView | null {
  const number = chosen ?? view.preselect;
  return number == null ? null : (view.items.find((item) => item.number === number) ?? null);
}

/**
 * How the pack uses this photo (docs/phases/PHASE_15.md item 31). Absent
 * means today's pack: the background is removed and a cutout is made from
 * the photo.
 */
export interface PhotoOutputContext {
  /** The seller keeps this photo's background. */
  kept: boolean;
  /** Some planned shot cuts the product out of this photo (@curvi/pipeline
   * output-options cutoutMediaIds). */
  feedsCutout: boolean;
}

/** A kept photo that shows other items and feeds no cutout (PHASE_15
 * "Several products in one photo"). */
export const OTHER_ITEMS_KEPT_COPY =
  "This photo shows other items. With the background kept, they stay in your images. Turn on Remove the background to show only your product.";

/**
 * The selected specs a kept photo with added text, borders or watermarks is
 * left out of: those that take a kept photo and refuse overlays in the
 * registry (eBay, Google), as the planner's applyAddedOverlays does.
 */
export function addedTextSpecIds(selected: readonly string[]): string[] {
  return selected.filter((id) => {
    if (!hasSpec(id)) return false;
    const spec = getSpec(id);
    return refusesOverlays(spec) && specAcceptsImage(spec, "original");
  });
}

/**
 * Under a kept photo intake saw added text on (PHASE_15 P1): "This photo
 * looks like it has added text, a border or a watermark, which eBay does not
 * allow, so it will be left out there. ..." Null for no specs.
 */
export function addedTextPhotoLine(specIds: readonly string[]): string | null {
  const families = [...new Set(specIds.map(familyName))];
  if (families.length === 0) return null;
  const one = families.length === 1;
  return `This photo looks like it has added text, a border or a watermark, which ${joinNames(families)} ${one ? "does" : "do"} not allow, so it will be left out there. Upload a clean photo to include it, or leave ${one ? "this channel" : "these channels"} out. Your product's own logo and labels are fine.`;
}

export interface SizeShortfall {
  specId: string;
  measure: "product" | "photo";
  needs: number;
  has: number;
}

/**
 * The selected channels this photo is too small for. A kept photo that feeds
 * no cutout has no product region to measure, so only needs on the whole
 * photo count for it.
 */
export function sizeShortfalls(
  view: PreflightView,
  selected: readonly string[],
  chosen?: number | null,
  output?: PhotoOutputContext,
): SizeShortfall[] {
  if (!view.photo) return [];
  const photoOnly = output !== undefined && output.kept && !output.feedsCutout;
  const photoLong = Math.max(view.photo.width, view.photo.height);
  const productLong = chosenItem(view, chosen)?.longSide ?? view.productLongSide ?? null;
  const shortfalls: SizeShortfall[] = [];
  for (const need of view.sizes) {
    if (!selected.includes(need.specId)) continue;
    if (photoOnly && need.measure === "product") continue;
    const has = Math.round(need.measure === "product" ? (productLong ?? photoLong) : photoLong);
    if (has < need.needs) {
      shortfalls.push({ specId: need.specId, measure: need.measure, needs: need.needs, has });
    }
  }
  return shortfalls;
}

/** One size problem with its numbers and the fix. */
export function sizeShortfallLine(shortfall: SizeShortfall, photo: { width: number; height: number }): string {
  const name = specName(shortfall.specId);
  const size = `This photo is ${photo.width} by ${photo.height} pixels`;
  const measured =
    shortfall.measure === "product"
      ? `${size} and the product in it is about ${shortfall.has} pixels across. ${name} needs about ${shortfall.needs}.`
      : `${size}. ${name} needs about ${shortfall.needs} on the long side.`;
  return `Too small for ${name}. ${measured} Upload the original photo from your camera, or untick ${name}.`;
}

/** "Found: silver watch. Ready for Amazon, Shopify and Meta." or null when
 * nothing is ready yet. */
export function readyLine(view: PreflightView, selected: readonly string[], chosen?: number | null): string | null {
  // Nothing was checked for an unavailable preflight: only its notice shows.
  if (view.status === "blocked" || view.status === "unavailable") return null;
  const label = chosenItem(view, chosen)?.label ?? view.found;
  if (view.status === "choose" && !chosenItem(view, chosen)) return null;
  const short = new Set(sizeShortfalls(view, selected, chosen).map((s) => s.specId));
  const families = [...new Set(selected.filter((id) => !short.has(id)).map(familyName))];
  const found = label ? `Found: ${label}.` : "Found your product.";
  return families.length > 0 ? `${found} Ready for ${joinNames(families)}.` : found;
}

export interface PreflightBlockOptions {
  /** The photo's role shows several items on purpose (in the box). */
  multiItem?: boolean;
  /** How the pack uses the photo; absent means removed, as today. */
  output?: PhotoOutputContext;
}

/**
 * Why this photo cannot start a pack right now, or null when it can. A
 * photo whose role shows several items on purpose (in the box) needs no
 * choice, and neither does one that feeds no cutout: its other items stay
 * in the picture (keptPhotoHeadsUp says so). A kept photo never blocks on
 * size; where it is too small it is left out of that channel at plan time.
 * A removed photo keeps today's rules.
 */
export function preflightBlockReason(
  view: PreflightView,
  selected: readonly string[],
  chosen: number | null | undefined,
  opts: PreflightBlockOptions = {},
): string | null {
  if (view.status === "blocked" && view.problem) {
    return `${view.problem.title} ${view.problem.fix}`;
  }
  const feedsCutout = opts.output === undefined || opts.output.feedsCutout;
  if (view.status === "choose" && !opts.multiItem && feedsCutout && !chosenItem(view, chosen)) {
    return "Tap the product this pack is for.";
  }
  if (opts.output?.kept) {
    return null;
  }
  const short = sizeShortfalls(view, selected, chosen, opts.output);
  if (short.length > 0) {
    return `This photo is too small for ${joinNames(short.map((s) => specName(s.specId)))}. Untick ${short.length === 1 ? "it" : "them"} or upload a larger photo.`;
  }
  return null;
}

/**
 * What the form says under a kept photo instead of blocking: its other
 * items stay in the picture, the channels its added text keeps it out of,
 * and the channels it may be too small for. Empty
 * for a removed photo. The exact pixel numbers per channel come from the
 * conflicts (output-options-copy.ts tooSmallLine).
 */
export function keptPhotoHeadsUp(
  view: PreflightView,
  selected: readonly string[],
  chosen: number | null | undefined,
  output: PhotoOutputContext | undefined,
): string[] {
  if (!output?.kept) return [];
  const lines: string[] = [];
  if (view.status === "choose" && !output.feedsCutout) {
    lines.push(OTHER_ITEMS_KEPT_COPY);
  }
  if (view.addedOverlays === true) {
    const line = addedTextPhotoLine(addedTextSpecIds(selected));
    if (line) lines.push(line);
  }
  const short = sizeShortfalls(view, selected, chosen, output);
  if (short.length > 0) {
    lines.push(
      `This photo may be too small for ${joinNames(short.map((s) => specName(s.specId)))}, so it will be left out where it is too small. Upload the original from your camera to include it.`,
    );
  }
  return lines;
}

/** Tips for a photo with no product we could find (PHASE_14.md 3.3). */
export const PHOTO_TIPS = [
  "Put one product in the frame, with nothing else next to it.",
  "Use a plain background, like a wall, a table or a sheet of paper.",
  "Keep the whole product in view, not cut off at the edges.",
] as const;

/** The problem copy for a blocking preflight. */
export function problemFor(
  code: PreflightProblem["code"],
  detail: { reasons?: readonly string[]; notice?: string } = {},
): PreflightProblem {
  switch (code) {
    case "prohibited":
      return {
        code,
        title: `We cannot make images from this photo because it shows ${joinNames(detail.reasons ?? ["something we do not allow"])}.`,
        fix: "Curvi does not make listings for adult content, weapons, drugs or other prohibited goods. Upload a photo of a different product.",
      };
    case "screenshot":
      return {
        code,
        title: "This looks like a screenshot, not a photo of the product.",
        fix: "Upload the photo from your camera, or the original image file, instead.",
        tips: [...PHOTO_TIPS],
      };
    case "no_product":
      return {
        code,
        title: "We could not find a product in this photo.",
        fix: "Try a photo where the product is easy to see.",
        tips: [...PHOTO_TIPS],
      };
    case "invalid_upload":
      return {
        code,
        title: detail.notice ?? "This file could not be read as a photo.",
        fix: "Remove it and upload a JPEG, PNG or WEBP photo instead.",
      };
  }
}

/** The notice when the inventory could not run. */
export const CUTOUT_UNAVAILABLE_NOTICE =
  "We could not check this photo for other items right now, so the pack will check again when it runs.";

/** The notice when the check itself could not run. */
export const PREFLIGHT_UNAVAILABLE_NOTICE =
  "We could not check this photo right now. You can still start the pack, and it will check the photo when it runs.";
