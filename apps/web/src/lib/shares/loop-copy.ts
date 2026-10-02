/**
 * The words of the share loop and the gallery labels (docs/phases/
 * PHASE_18.md P18-14). Plain spoken, no emojis, no arrows and no dashes used
 * as punctuation (CLAUDE.md rule 9); loop-copy.test.ts lints them.
 */

import type { ShareNetwork } from "./share-links";

/** Posted with every shared link. */
export const SHARE_TEXT = "One photo, a full listing pack, and the product was never redrawn. Made with Curvi.";

/** The gallery label on a pack made in an operator's workspace (decision 15). */
export const TEAM_GALLERY_LABEL = "Made by the Curvi team";
/** The gallery label on a seller's own pack. */
export const SELLER_GALLERY_LABEL = "Shared by the seller";

export const SHARE_NETWORK_LABELS: Record<ShareNetwork, string> = {
  x: "Post on X",
  linkedin: "Share on LinkedIn",
  pinterest: "Save to Pinterest",
  reddit: "Post on Reddit",
};

export const SHARE_BUTTONS_COPY = {
  heading: "Share it",
  device: "Share from this phone",
  hint: "Each button opens the network's own page with your link filled in. Nothing is posted until you post it there.",
  revealHint: "To post this pack on X, LinkedIn, Pinterest or Reddit, make its share page in the panel below and use the buttons there.",
  revealLink: "Go to sharing",
} as const;

/** "Ana, Juniper Candles" under a quote; nothing when the seller gave no name. */
export function quoteAttribution(name: string | null): string | null {
  const trimmed = name?.trim();
  return trimmed ? trimmed : null;
}

export function allLoopCopy(): string[] {
  return [
    SHARE_TEXT,
    TEAM_GALLERY_LABEL,
    SELLER_GALLERY_LABEL,
    ...Object.values(SHARE_NETWORK_LABELS),
    ...Object.values(SHARE_BUTTONS_COPY),
  ];
}
