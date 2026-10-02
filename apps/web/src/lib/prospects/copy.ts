/**
 * The words of the prospect makeover tool (docs/phases/PHASE_18.md P18-04):
 * the claim call to action and takedown footer on a prospect's share page,
 * the share title, the operator page, and the draft outreach note. Plain
 * spoken, no emojis, no arrows and no dashes used as punctuation (CLAUDE.md
 * rule 9); prospects-copy.test.ts lints every string here.
 */

import { prospectClaims, staffMonthlyCreditCap } from "@curvi/pipeline/seed";

/** "{store} listing pack, made by Curvi": the title of a prospect's page. */
export function prospectShareTitle(store: string): string {
  return `${store} listing pack, made by Curvi`;
}

/** The claim call to action on the page the claim link opens. */
export function claimCtaText(store: string): string {
  return `This pack was made for ${store} from your current listing photo. Make it yours: create a free account and your product is ready to go.`;
}

export const CLAIM_COPY = {
  button: "Make it yours",
  footerQuestion: "Not yours, or want this page removed?",
  takedownLink: "Take it down here",
  footerEmail: "or email hello@curvi.ai.",
  footerEmailOnly: "Email hello@curvi.ai and we take it down.",
  confirm: "Take this page down? The link stops working for everyone.",
  confirmButton: "Yes, take it down",
  cancel: "Keep it",
  done: "This page is down. Thank you for telling us.",
  failed: "That did not work. Email hello@curvi.ai and we take it down.",
  notFound: "This link no longer works.",
} as const;

export const PROSPECT_PAGE_COPY = {
  title: "Prospect packs",
  intro:
    "Make a free listing pack for a seller you want to reach, from their product link or listing photo. Each pack gets a link only share page with its measured checks, never in the gallery, and a claim link that turns into a free account with their product ready.",
  needsDatabase: "Prospect packs need the database. Set DATABASE_URL and the Supabase variables.",
  unavailable: "The prospect list could not be read just now. Try again in a minute.",
  creditsTitle: "Prospect credits",
  creditsLine: (used: number, balance: number) =>
    `Added this month: ${used} of ${staffMonthlyCreditCap}. Balance now: ${balance}.`,
  creditsLabel: "Credits to add",
  creditsButton: "Add prospect credits",
  creditsAdded: (credits: number) => `Added ${credits} credits.`,
  creditsOverCap: (left: number) =>
    left > 0 ? `That passes this month's cap. You can add up to ${left} more.` : "This month's cap is used up.",
  creditsInvalid: `Pick a whole number from 1 to ${prospectClaims.maxCreditsPerAdd}.`,
  formTitle: "New prospect pack",
  storeLabel: "Store name",
  storeHint: "As the seller writes it. It titles the share page and the note.",
  linkLabel: "Product link (optional)",
  linkHint: "A Shopify or Amazon product page. If it does not import, add the listing photo instead.",
  photoLabel: "Listing photo",
  photoHint: "Needed when there is no link or the link did not import.",
  titleLabel: "Product name (optional)",
  channelsLabel: "Channels",
  noteLabel: "Note for the pack (optional)",
  submit: "Make the prospect pack",
  working: "Making the pack",
  importing: "Reading the product link",
  uploading: "Uploading the photo",
  importFailed: (message: string) => `The link did not import: ${message} Add the listing photo instead.`,
  needStore: "Type the store name.",
  needPhoto: "Add the product link or the listing photo.",
  needChannel: "Pick at least one channel.",
  created: "Pack started. It shows here as ready when it is done.",
  listTitle: "Your prospect packs",
  empty: "No prospect packs yet.",
  openPack: "Open the pack",
  makeLink: "Make the claim link",
  remakeLink: "Make a new claim link",
  remakeHint: "A new link replaces the old one, which stops working.",
  showKit: "Show the outreach kit",
  kitNoLink: "No claim link to show. Make the claim link when you are ready to send.",
  kitLinkPlaceholder: "[claim link]",
  copy: "Copy",
  copied: "Copied",
  states: {
    making: "Making",
    ready: "Ready to send",
    failed: "Failed",
    claimed: "Claimed",
    taken_down: "Taken down",
    expired: "Link expired",
  },
  kitTitle: "Outreach kit",
  kitLink: "Claim link",
  kitCheck: "Their current main image, Amazon checker",
  kitCheckMissing: "The current main image could not be measured.",
  kitPass: "Pass",
  kitFail: "Fail",
  kitFidelity: "Product check on the pack",
  kitNote: "Draft note",
  kitNoteHint:
    "Check the do not contact list first. Edit the note, then send it from the outreach domain with the signature below it, which gives your postal address, says the email is promotional and offers an opt out. Curvi sends nothing to prospects.",
  kitName: "Their first name",
  kitFounder: "Your name",
  failedGeneric: "That did not work. Try again in a minute.",
} as const;

/** "0.84 average color difference, all files inside their limits", for the kit. */
export function fidelityLine(summary: {
  measuredFiles: number;
  deliveredFiles: number;
  highestMeanDeltaE: number | null;
  allWithinLimits: boolean;
}): string {
  if (summary.measuredFiles === 0 || summary.highestMeanDeltaE === null) {
    return "No file of this pack carries measured numbers yet.";
  }
  const limits = summary.allWithinLimits ? "every measured file inside its limit" : "a file outside its limit";
  return `Color check inside the product: highest average color difference ${summary.highestMeanDeltaE.toFixed(2)} across ${summary.measuredFiles} of ${summary.deliveredFiles} files, ${limits}.`;
}

export interface DraftNoteInput {
  name: string;
  product: string;
  /** Share of the edge pixels at pure white, as a percent, or null. */
  whitePercent: number | null;
  /** The product's fill of the frame, as a percent, or null. */
  fillPercent: number | null;
  link: string;
  founder: string;
}

function oneDecimal(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "");
}

/**
 * The draft outreach note (P18-04 "Copy"), built from the measured values.
 * Without a measurement the checker sentence is left out rather than
 * guessed. The founder edits and sends it from their own inbox.
 */
export function draftNote(input: DraftNoteInput): string {
  const name = input.name.trim() || "there";
  const product = input.product.trim() || "product";
  const founder = input.founder.trim();
  const measured =
    input.whitePercent !== null && input.fillPercent !== null
      ? ` I ran your ${product} main image through our Amazon checker. The background measures ${oneDecimal(input.whitePercent)} percent pure white and the product fills ${oneDecimal(input.fillPercent)} percent of the frame.`
      : "";
  const lines = [
    `Hi ${name},${measured} I made a full listing pack from the same photo, free, without redrawing your product: ${input.link}. If it is useful, I can do your next three products.`,
  ];
  if (founder) {
    lines.push(founder);
  }
  return lines.join("\n\n");
}

/**
 * The outreach signature every cold email carries (docs/marketing.md
 * section 11): CAN-SPAM asks a commercial email for a postal address, a
 * clear statement that it is an ad and a way to opt out. The founder
 * replaces the address placeholder before sending.
 */
export function outreachSignature(founder: string): string {
  return [
    founder.trim() || "[Your first name]",
    "Founder, Curvi",
    "https://curvi.ai",
    "[Postal address]",
    "This is a promotional email from Curvi.",
    'If you would rather not hear from me, reply "no thanks" and I will not write again.',
  ].join("\n");
}

/** The draft note with the outreach signature under it, as the kit shows it. */
export function draftEmail(input: DraftNoteInput): string {
  return `${draftNote({ ...input, founder: "" })}\n\n${outreachSignature(input.founder)}`;
}

/** Words in a note, as a reader counts them (the link is one word). */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}
