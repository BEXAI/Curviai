/**
 * Seller copy for the output options (docs/phases/PHASE_15.md controls 3, 4
 * and 6, "Several products in one photo" and the Copy table), CLAUDE.md rule
 * 9. @curvi/pipeline/output-options answers with conflict codes only; every
 * sentence a seller reads about them lives here. Pure and client safe.
 *
 * Numbers and names come from their sources (rule 2): the enlarge limit from
 * MAX_SOURCE_UPSCALE, which channels need white from the registry through
 * requiresWhiteBackground, channel names from specDisplayName and the
 * preflight family names. A registry spec with no line of its own gets a
 * generic one, so a new entry never ships without copy.
 */

import {
  MAX_SOURCE_UPSCALE,
  type ExtraFamily,
  type LookKey,
  type OutputConflict,
  type OutputConflictCode,
} from "@curvi/pipeline/output-options";
import { hasSpec, getSpec, listSpecs, requiresWhiteBackground, type ChannelSpec } from "@curvi/specs";
import { specDisplayName } from "@/components/marketing/spec-slug";
import { familyName, joinNames, OTHER_ITEMS_KEPT_COPY, specName } from "@/lib/preflight/copy";

export { OTHER_ITEMS_KEPT_COPY };

/** The three looks by name, for the cards, the Custom chip and the summary. */
export const LOOK_TITLES: Readonly<Record<LookKey, string>> = {
  marketplace: "Marketplace ready",
  keep_photo: "Keep my photo",
  brand: "Brand look",
};

/** The extra image families as a seller names them, for "Turned off: ...". */
export const EXTRA_FAMILY_NAMES: Readonly<Record<ExtraFamily, string>> = {
  scenes: "lifestyle scenes",
  backdrops: "studio backdrops",
  transparentPng: "transparent PNG",
  graphics: "graphics",
  cards: "social posts and banners",
};

/** The enlarge limit in words: 1.5 reads "1.5", 2 reads "2". */
export function upscaleLimitText(limit: number = MAX_SOURCE_UPSCALE): string {
  return String(Math.round(limit * 100) / 100);
}

/**
 * The enlarge limit as the end of a too small sentence, for the cap the pack
 * actually uses (keptMaxUpscale): "without enlarging it more than 1.5 times",
 * or, with Never enlarge my photo (a cap of 1), "without enlarging it, since
 * you chose Never enlarge my photo".
 */
export function enlargeLimitClause(limit: number = MAX_SOURCE_UPSCALE): string {
  return limit <= 1
    ? "without enlarging it, since you chose Never enlarge my photo"
    : `without enlarging it more than ${upscaleLimitText(limit)} times`;
}

const LEAVE_IT_OUT = "Leave it out";

interface WhiteRequiredChannelCopy {
  /** The channel's name in the "stay pure white" list. */
  name: string;
  /** The heads up with a kept photo. */
  line: string;
  /** The text button that unticks it. */
  leaveOut: string;
}

/**
 * Lines for the white required channels in the registry today (control 4).
 * Walmart and TikTok Shop have one spec each, so leaving the spec out leaves
 * the whole channel out.
 */
const WHITE_REQUIRED_COPY: Readonly<Record<string, WhiteRequiredChannelCopy>> = {
  "amazon.main": {
    name: "Amazon main image",
    line: "Amazon's main image must be pure white, so this one image has its background removed.",
    leaveOut: LEAVE_IT_OUT,
  },
  "walmart.main": {
    name: "Walmart",
    line: "Walmart takes white backgrounds only, so your Walmart images have the background removed.",
    leaveOut: "Leave Walmart out",
  },
  "google.merchant.main": {
    name: "Google main image",
    line: "Google's main image must be white or transparent, so its background is removed.",
    leaveOut: LEAVE_IT_OUT,
  },
  "tiktokshop.main": {
    name: "TikTok Shop",
    line: "TikTok Shop asks for a pure white main image, so your TikTok Shop images have the background removed.",
    leaveOut: "Leave TikTok Shop out",
  },
};

/** A spec's name for the seller: specDisplayName, or words built from the id
 * for a registry entry that has no display name yet. */
export function channelName(specId: string): string {
  const display = specDisplayName(specId);
  return display === specId ? specName(specId) : display;
}

/** The white required copy for a spec, with the generic fallback built from specDisplayName. */
export function whiteRequiredCopy(specId: string): WhiteRequiredChannelCopy {
  const known = WHITE_REQUIRED_COPY[specId];
  if (known) {
    return known;
  }
  const name = channelName(specId);
  return {
    name,
    line: `${name} needs a white background, so its background is removed.`,
    leaveOut: LEAVE_IT_OUT,
  };
}

/**
 * The picked specs that stay white whatever the color, in registry order,
 * read from the registry rule (never a list of ids).
 */
export function whiteRequiredSpecIds(specIds: readonly string[], specs: readonly ChannelSpec[] = listSpecs()): string[] {
  const picked = new Set(specIds);
  return specs.filter((spec) => picked.has(spec.id) && requiresWhiteBackground(spec)).map((spec) => spec.id);
}

/**
 * With Remove and a color other than white, one line naming the white
 * required channels picked: "Amazon main image, Google main image, Walmart
 * and TikTok Shop stay pure white. Your color is used everywhere else."
 * Null when none is picked.
 */
export function whiteChannelsLine(specIds: readonly string[], specs: readonly ChannelSpec[] = listSpecs()): string | null {
  const names = whiteRequiredSpecIds(specIds, specs).map((id) => whiteRequiredCopy(id).name);
  if (names.length === 0) {
    return null;
  }
  return `${joinNames(names)} ${names.length === 1 ? "stays" : "stay"} pure white. Your color is used everywhere else.`;
}

/** The families of these specs, each named once, in order. */
function familyNames(specIds: readonly string[]): string[] {
  return [...new Set(specIds.map(familyName))];
}

/** eBay, Google: a kept photo keeps its own shape where borders are refused (control 6). */
export function bordersRefusedLine(specId: string): string {
  const family = familyName(specId);
  return `${family} does not allow added borders, so ${family} images keep your photo's shape.`;
}

/**
 * The added text heads up (Keep, eBay or Google picked): "eBay and Google do
 * not allow added text, borders or watermarks on photos. ..." Null for no
 * specs.
 */
export function overlaysRefusedLine(specIds: readonly string[]): string | null {
  const families = familyNames(specIds);
  if (families.length === 0) {
    return null;
  }
  const one = families.length === 1;
  return `${joinNames(families)} ${one ? "does" : "do"} not allow added text, borders or watermarks on photos. If yours has any, leave ${one ? "this channel" : "these channels"} out or upload a clean photo. Your product's own logo and labels are fine.`;
}

/** The soft note for a spec whose rule asks for one consistent style (shopify.product). */
export function consistentStyleNote(specId: string): string {
  return `${familyName(specId)} suggests one background style across your store.`;
}

/** The Copy table's Shopify soft note. */
export const SHOPIFY_SOFT_NOTE = consistentStyleNote("shopify.product");

/**
 * A kept photo too small for a spec within the enlarge limit: "This photo is
 * 900 by 675 pixels, too small for Amazon secondary images without
 * enlarging it more than 1.5 times, so it will be left out there. ..."
 */
export function tooSmallLine(
  specId: string,
  photo?: { width?: number; height?: number } | null,
  maxUpscale: number = MAX_SOURCE_UPSCALE,
): string {
  const size =
    photo?.width !== undefined && photo.height !== undefined
      ? `This photo is ${photo.width} by ${photo.height} pixels, too small`
      : "This photo is too small";
  return `${size} for ${channelName(specId)} ${enlargeLimitClause(maxUpscale)}, so it will be left out there. Upload the original from your camera to include it.`;
}

/** A report note on a white required file when the seller picked another color (control 3). */
export const FORCED_WHITE_NOTE = "This channel needs pure white, so this file uses white instead of your color.";

/** Shown under a custom color darker than the seeded limit while dark swatches wait (control 3). */
export const DARK_COLOR_EDGE_NOTE = "Dark colors can show a light edge around your product.";

/** What the form knows when it words the conflicts. */
export interface ConflictCopyContext {
  /** The pack's background choice. */
  background: "remove" | "keep";
  /** The pack's photos, for the pixel numbers in the too small line. */
  photos?: readonly { id: string; width?: number; height?: number }[];
  /** The enlarge cap conflictsFor used (keptMaxUpscale), so the too small
   * line names the seller's own choice. MAX_SOURCE_UPSCALE when absent. */
  maxUpscale?: number;
}

/** One heads up line under a channel row or in "Heads up for your channels". */
export interface ConflictLine {
  code: OutputConflictCode;
  text: string;
  /** The channels "Leave it out" unticks; empty when there is nothing to untick. */
  specIds: string[];
  /** The photo the line is about, when it is about one. */
  photoId?: string;
  /** The text button that unticks specIds, when there is one. */
  leaveOutLabel?: string;
}

function photoOf(context: ConflictCopyContext, photoId: string | undefined) {
  return photoId === undefined ? undefined : context.photos?.find((photo) => photo.id === photoId);
}

/** The line for one conflict, as shown under its channel row. */
export function conflictCopy(conflict: OutputConflict, context: ConflictCopyContext): ConflictLine {
  const specId = conflict.specId;
  const base = { code: conflict.code, ...(conflict.photoId !== undefined ? { photoId: conflict.photoId } : {}) };
  switch (conflict.code) {
    case "white_required": {
      const id = specId ?? "";
      const copy = whiteRequiredCopy(id);
      const text =
        context.background === "keep" ? copy.line : `${copy.name} stays pure white. Your color is used everywhere else.`;
      return { ...base, text, specIds: [id], leaveOutLabel: copy.leaveOut };
    }
    case "borders_refused":
      return { ...base, text: bordersRefusedLine(specId ?? ""), specIds: [] };
    case "overlays_refused":
      return {
        ...base,
        text: overlaysRefusedLine([specId ?? ""]) ?? "",
        specIds: specId ? [specId] : [],
        leaveOutLabel: LEAVE_IT_OUT,
      };
    case "mixed_consistent":
      return { ...base, text: consistentStyleNote(specId ?? ""), specIds: [] };
    case "other_items":
      return { ...base, text: OTHER_ITEMS_KEPT_COPY, specIds: [] };
    case "too_small":
      return {
        ...base,
        text: tooSmallLine(specId ?? "", photoOf(context, conflict.photoId), context.maxUpscale),
        specIds: [],
      };
  }
}

/**
 * "Heads up for your channels": every conflict worded once. With Remove the
 * white required channels share one line; the added text heads up names
 * every channel it is about in one line; the rest follow conflictsFor's
 * order, each distinct line once.
 */
export function conflictLines(conflicts: readonly OutputConflict[], context: ConflictCopyContext): ConflictLine[] {
  const out: ConflictLine[] = [];
  const seen = new Set<string>();
  const push = (line: ConflictLine) => {
    if (line.text && !seen.has(line.text)) {
      seen.add(line.text);
      out.push(line);
    }
  };
  const white = conflicts.filter((c) => c.code === "white_required" && c.specId).map((c) => c.specId as string);
  const overlays = conflicts.filter((c) => c.code === "overlays_refused" && c.specId).map((c) => c.specId as string);
  for (const conflict of conflicts) {
    if (conflict.code === "white_required" && context.background === "remove") {
      if (white[0] === conflict.specId) {
        const text = whiteChannelsLine(white, white.filter(hasSpec).map(getSpec));
        if (text) push({ code: "white_required", text, specIds: [] });
      }
      continue;
    }
    if (conflict.code === "overlays_refused") {
      if (overlays[0] === conflict.specId) {
        const text = overlaysRefusedLine(overlays);
        if (text) {
          push({
            code: "overlays_refused",
            text,
            specIds: [...overlays],
            leaveOutLabel: overlays.length === 1 ? LEAVE_IT_OUT : "Leave them out",
          });
        }
      }
      continue;
    }
    push(conflictCopy(conflict, context));
  }
  return out;
}

// The Copy table's pause rows (PHASE_15 "Provider pauses").

/** The banner while cutouts are paused and a pack with kept photos is still possible. */
export const KEEP_PHOTOS_PAUSED_COPY =
  "Background removal is paused for a few minutes while an image service recovers. You can still keep your photos as they are for channels that do not need a white background. Nothing will be charged.";

/** The same banner when the cutout account is out of credit, which no wait
 * fixes: it makes no time promise. */
export const KEEP_PHOTOS_PAUSED_QUOTA_COPY =
  "Background removal is paused right now. You can still keep your photos as they are for channels that do not need a white background. Nothing will be charged.";

/** The banner's button. */
export const KEEP_PHOTOS_INSTEAD_LABEL = "Keep my photos instead";

/**
 * After "Keep my photos instead" unticks the white required channels: "We
 * left out Amazon main image and Walmart because they need the background
 * removed." Null when nothing was left out.
 */
export function leftOutAfterPauseLine(specIds: readonly string[]): string | null {
  const names = specIds.map((id) => whiteRequiredCopy(id).name);
  if (names.length === 0) {
    return null;
  }
  return `We left out ${joinNames(names)} because ${names.length === 1 ? "it needs" : "they need"} the background removed.`;
}

/** The runner could not read the stored options and failed closed. */
export const OPTIONS_UNREADABLE_COPY =
  "This pack's image choices could not be read, so nothing was charged. Please try again.";

/** The kill switch is off, so the pack runs as Marketplace ready. */
export const OPTIONS_PAUSED_COPY = `Image choices are paused right now, so this pack uses ${LOOK_TITLES.marketplace}.`;

/** The makeover title when every hero candidate is the seller's own photo (item 34). */
export const SIZED_FOR_EACH_CHANNEL_TITLE = "Sized for each channel";
