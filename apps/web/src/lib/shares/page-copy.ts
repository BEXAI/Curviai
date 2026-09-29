/**
 * Words on a public share page (/s/{slug}): its title, meta description,
 * social card alt text and intro. A page whose hero is the seller's own kept
 * photo (PHASE_15 item 34) is no makeover, so it never claims a before and
 * after or a slider. Pure and client safe.
 */

import { SIZED_FOR_EACH_CHANNEL_TITLE } from "@/lib/output-options-copy";
import { TITLE_MAX } from "@/lib/seo";
import type { PublicShare } from "./types";

type ShareCopyInput = Pick<PublicShare, "title" | "before" | "sizedForChannels">;

/** Leave room for the " | Curvi" the layout template adds. */
const TITLE_ROOM = TITLE_MAX - 8;

/** The page title: the product and what the page shows. */
export function shareTitle(share: Pick<PublicShare, "title" | "sizedForChannels">): string {
  const suffix = share.sizedForChannels ? SIZED_FOR_EACH_CHANNEL_TITLE.toLowerCase() : "before and after";
  const full = `${share.title}, ${suffix}`;
  if (full.length <= TITLE_ROOM) {
    return full;
  }
  return share.sizedForChannels ? `A product photo, ${suffix}` : "A product photo makeover, before and after";
}

/** The meta description, before fitDescription trims it. */
export function shareDescription(share: ShareCopyInput): string {
  if (share.sizedForChannels) {
    return `${share.title}: the seller's own product photo, sized for each sales channel with Curvi. The product pixels are never regenerated.`;
  }
  const compare = share.before ? " Drag the slider to compare." : "";
  return `${share.title}: one product photo in, a studio pack out, made with Curvi. The product pixels are never regenerated.${compare}`;
}

/** Alt text of the social card image. */
export function shareOgAlt(share: Pick<PublicShare, "title" | "before" | "sizedForChannels">): string {
  if (share.sizedForChannels) {
    return `${share.title}, ${SIZED_FOR_EACH_CHANNEL_TITLE.toLowerCase()}, made with Curvi`;
  }
  return share.before ? `${share.title}, before and after, made with Curvi` : `${share.title}, made with Curvi`;
}

/** The line under the page heading. */
export function shareIntro(share: ShareCopyInput): string {
  if (share.sizedForChannels) {
    return "The seller's own photo, fitted to each channel's size and background rules. The product itself is never regenerated, so what a buyer sees is the real item.";
  }
  return share.before
    ? "Drag the divider to compare the original photo with the result. The product itself is never regenerated, so what a buyer sees is the real item."
    : "The result from one product photo. The product itself is never regenerated, so what a buyer sees is the real item.";
}

/** Heading of the grid of every delivered file. */
export function sharePackHeading(share: Pick<PublicShare, "sizedForChannels">): string {
  return share.sizedForChannels ? SIZED_FOR_EACH_CHANNEL_TITLE : "The whole pack";
}
