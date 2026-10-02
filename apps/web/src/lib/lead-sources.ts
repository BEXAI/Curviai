/**
 * Lead capture constants shared by the email gate (client) and the leads
 * route. Kept free of imports so the free tool pages stay small.
 */

/** Where an email can be left. Stored as the lead's source. */
export const LEAD_SOURCES = [
  "main-image-checker",
  "white-background-fixer",
  "marketplace-resizer",
  "share-page",
  "gallery",
  // Phase 18 (docs/phases/PHASE_18.md, contract commit).
  // P18-03: "Get notified when packs are back" while acquisition is waitlisted.
  "packs-paused",
  // P18-12: the full size file of a free white main image preview.
  "free-preview",
  // P18-18: the per product table of the store image audit.
  "store-audit",
] as const;

export type LeadSource = (typeof LEAD_SOURCES)[number];

/** The honeypot field. It is hidden from people, so only bots fill it in. */
export const LEAD_HONEYPOT_FIELD = "website";
