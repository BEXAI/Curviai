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
] as const;

export type LeadSource = (typeof LEAD_SOURCES)[number];

/** The honeypot field. It is hidden from people, so only bots fill it in. */
export const LEAD_HONEYPOT_FIELD = "website";
