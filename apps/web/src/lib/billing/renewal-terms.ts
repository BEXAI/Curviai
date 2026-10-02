/**
 * The renewal terms shown beside every plan buy button and in Stripe
 * Checkout (docs/phases/PHASE_20.md P20-07, founder decision 4). They state
 * the automatic renewal offer terms the state laws ask for: that the plan
 * continues until the buyer cancels, how to cancel, the recurring charge and
 * that it may change, the renewal term, the deadline to cancel, and that
 * there is no minimum term. Prices and the reminder window come from the
 * seed (CLAUDE.md rule 2); only wording lives here. Client safe: the pricing
 * cards, the billing plan picker and the checkout route share it.
 *
 * Not legal advice: counsel confirms coverage (decision 4).
 */

import { renewalNotices, taxDisplay, tierByKey } from "@curvi/pipeline/seed";
import { addMonths } from "./cancel-flow";
import { formatUsd, priceForCadence, tierDisplayName, type BillingCadence, type PaidTierKey } from "./plans";

/**
 * The version of the renewal wording below. Checkout stores it, with a hash
 * of the exact text, in the session metadata, and the consent record copies
 * both, so a record always says what the buyer saw. Change it with the text.
 */
export const RENEWAL_DISCLOSURE_VERSION = "2026-10-02.2";

export const PRICE_CHANGE_LINE = "If our price changes, we email you before it applies, and you can cancel.";

/** What canceling a yearly plan means (law and copy review major 1). */
export const YEARLY_CANCEL_LINE =
  "If you cancel, you keep your plan until the end of the year you paid for. We do not refund the rest of the year.";

/** The renewal price of a plan from the seed: "$29 a month", "$792 a year". */
export function renewalPrice(tier: PaidTierKey, cadence: BillingCadence): string {
  const price = formatUsd(priceForCadence(tierByKey(tier), cadence).billedUsd);
  return `${price} a ${cadence === "annual" ? "year" : "month"}`;
}

/**
 * Checkout accepts promotion codes, and the disclosure beside its pay button
 * states the list price. This line says what a code changes, so a buyer
 * with a founding code is not recorded as agreeing to a price they never
 * saw (law and copy review major 2). Checkout only: the site has no code
 * field.
 */
export function promotionCodeLine(tier: PaidTierKey, cadence: BillingCadence): string {
  return `If you use a promotion code, Checkout shows the discounted price and how long it lasts. After that, your plan renews at ${renewalPrice(tier, cadence)}.`;
}

/** Shown on pricing and billing only while Stripe Tax is on (decision 3). */
export const TAX_LINE = "Prices are in US dollars. Tax is added at checkout where it applies.";

export interface RenewalTermsInput {
  tier: PaidTierKey;
  cadence: BillingCadence;
  /** When the first renewal would be; the cancel deadline. Null where the
   * page cannot know it (the static pricing page). */
  renewsOn?: Date | null;
}

/** The first renewal of a plan bought at `start`: one month or one year on. */
export function firstRenewal(start: Date, cadence: BillingCadence): Date {
  return addMonths(start, cadence === "annual" ? 12 : 1);
}

/** "November 2, 2026". */
export function formatRenewalDate(date: Date): string {
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function deadline(renewsOn: Date | null | undefined): string {
  return renewsOn
    ? `To avoid the next charge, cancel before ${formatRenewalDate(renewsOn)}.`
    : "To avoid the next charge, cancel before your next renewal date.";
}

/** The disclosure for one plan and cadence. */
export function renewalDisclosure(input: RenewalTermsInput): string {
  const tier = tierByKey(input.tier);
  const name = tierDisplayName(input.tier);
  const price = formatUsd(priceForCadence(tier, input.cadence).billedUsd);
  if (input.cadence === "annual") {
    const [earliest, latest] = renewalNotices.annualWindow;
    return [
      `Your Curvi ${name} plan renews automatically every year at ${price} plus any tax that applies, until you cancel.`,
      `We email you ${earliest} to ${latest} days before each renewal.`,
      "Cancel any time online in Billing.",
      deadline(input.renewsOn),
      YEARLY_CANCEL_LINE,
      "There is no minimum term.",
    ].join(" ");
  }
  return [
    `Your Curvi ${name} plan renews automatically every month at ${price} plus any tax that applies, until you cancel.`,
    "Cancel any time online in Billing.",
    deadline(input.renewsOn),
    "You keep your plan until the end of the month you paid for.",
    "There is no minimum term.",
  ].join(" ");
}

/** Everything shown beside a plan's buy button: the disclosure and the
 * price change line. */
export function renewalTerms(input: RenewalTermsInput): string {
  return `${renewalDisclosure(input)} ${PRICE_CHANGE_LINE}`;
}

/** The consent checkbox in Stripe Checkout (Markdown link to the terms). */
export function renewalCheckboxText(siteUrl: string): string {
  return `I agree that my plan renews automatically at the price above until I cancel, and I agree to the [Terms of Service](${siteUrl}/terms).`;
}

/** The tax line shows only while Stripe Tax adds tax to US prices. */
export function showTaxLine(taxEnabled: boolean): boolean {
  return taxEnabled && !taxDisplay.pricesIncludeTax;
}
