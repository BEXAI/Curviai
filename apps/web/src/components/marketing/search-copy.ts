/**
 * Copy for the free search tools (docs/phases/PHASE_18.md workstream F): the
 * main image checker's channel picker (P18-10) and the store image audit
 * (P18-18). Channel names and every number arrive as arguments, from the
 * spec registry and the growth seed, so nothing here can drift from the
 * rules. Kept free of runtime imports so the client side checker stays
 * small; the copy lint in search-copy.test.ts scans every string (CLAUDE.md
 * rule 9).
 */

import type { CheckerRules } from "@/lib/tools/main-image-analysis";

/** "A", "A or B", "A, B or C". */
export function orList(items: readonly string[]): string {
  if (items.length <= 1) {
    return items.join("");
  }
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** "A", "A and B", "A, B and C". */
function andList(items: readonly string[]): string {
  if (items.length <= 1) {
    return items.join("");
  }
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "a pure white background, a product fill of 85 to 90 percent and a longest side of at least 1600 px". */
export function checkerRulesPhrase(rules: CheckerRules): string {
  const parts = [rules.background === "white_or_transparent" ? "a white or transparent background" : "a pure white background"];
  if (rules.fillMinPercent !== null && rules.fillMaxPercent !== null) {
    parts.push(`a product fill of ${rules.fillMinPercent} to ${rules.fillMaxPercent} percent`);
  }
  if (rules.minLongSide > 1) {
    parts.push(`a longest side of at least ${rules.minLongSide} px`);
  } else if ((rules.minWidth ?? 0) > 1 || (rules.minHeight ?? 0) > 1) {
    parts.push(`a size of at least ${Math.max(1, rules.minWidth ?? 1)} by ${Math.max(1, rules.minHeight ?? 1)} px`);
  }
  return andList(parts);
}

export const checkerCopy = {
  pickerLabel: "Which marketplace?",
  title: (channel: string) => `${channel} Main Image Checker`,
  intro: (channel: string, rules: CheckerRules) =>
    // "published rules" in the plan's wording would trip the claims guard
    // (FEATURES.directPublishing matches "publish"), so the sentence says "own rules".
    `Check your ${channel} main image against ${channel}'s own rules in your browser: ${checkerRulesPhrase(rules)}. Nothing is uploaded.`,
  chooseFile: (channel: string) => `Choose your current ${channel} main image`,
  passBadge: (channel: string) => `Passes ${channel} main image rules`,
  failBadge: "Needs fixes before it passes",
  fixCta: "Fix this image free",
  rulesLinkLead: "Want the rules themselves? Read the",
  rulesLinkLabel: (channel: string) => `${channel} main image requirements`,
  rulesLinkTail: "page for the full spec in plain language.",
  /** The block on each main spec's requirements page. */
  requirementsTitle: "Check your main image",
  requirementsBody: "Check your main image against these rules, free, in your browser.",
  requirementsButton: "Check your main image",
};

export const storeAuditCopy = {
  title: "Shopify Store Image Audit",
  intro: (channels: readonly string[]) =>
    `Check every main image in your Shopify store against ${orList(channels)} rules. Free, no account.`,
  storeLabel: "Your Shopify store address",
  storePlaceholder: "yourstore.com",
  channelLabel: "Check against",
  submit: "Audit my store",
  busy: "Checking your store",
  how: (maxProducts: number) =>
    `We read your store's public product list and check the first image of up to ${maxProducts} products, the same way the free main image checker does. Nothing is stored and no account is needed.`,
  summary: (failing: number, checked: number, channel: string, thin: number, thinCount: number) =>
    `${checked === 0 ? "No main image could be checked." : `${failing} of ${checked} main images would not pass ${channel}'s rules.`} ${thin} ${thin === 1 ? "product has" : "products have"} fewer than ${thinCount} images.`,
  partial: (skipped: number) =>
    skipped === 1
      ? "1 product could not be checked, so it is left out of the count."
      : `${skipped} products could not be checked, so they are left out of the count.`,
  gateTitle: "See every product and what to fix",
  gateBody: "The summary above is free. Leave your email to see each product, its measured result and how many images it has.",
  tableProduct: "Product",
  tableImages: "Images",
  tableResult: "Main image",
  passCell: "Passes",
  failCell: (failed: readonly string[]) => `Fails: ${failed.join("; ")}`,
  noImage: "No image",
  notChecked: "Not checked",
  pack: "Curvi can rebuild each failing main image from the same photo without redrawing your product.",
  packCta: "Start free",
  checkerLink: "Check one image instead",
  /** The link from the main image checker, shown only while the audit is on. */
  fromCheckerLead: "Selling on Shopify?",
  fromCheckerLink: "Check every main image in your store at once",
};

/** Plain messages for every way an audit can be refused or fail. */
export const storeAuditErrors = {
  invalid_store: "Enter your store's address, for example yourstore.com.",
  blocked_host: "That address does not point to a public store.",
  amazon: "Amazon stores cannot be audited here. Check one Amazon main image with the free checker instead.",
  not_shopify:
    "We could not read a product list at that address. The audit works with Shopify stores that show their products publicly.",
  no_products: "That store shows no products publicly, so there is nothing to check.",
  store_busy: "That store asked us to slow down. Try again in a few minutes.",
  timeout: "That store took too long to answer. Try again in a minute.",
  too_large: "That store's product list is too large for us to read.",
  unreachable: "We could not reach that store. Check the address and try again.",
  daily_cap: "The store audit has reached today's limit. Try again tomorrow, or check one image with the free checker.",
  busy: "The store audit is busy right now. Try again in a minute.",
  off: "The store image audit is not available right now.",
  invalid: "Invalid request.",
} as const;

export type StoreAuditErrorReason = keyof typeof storeAuditErrors;
