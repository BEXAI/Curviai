/**
 * The fixed lines every lifecycle email carries (docs/phases/PHASE_18.md
 * P18-06). Plain spoken, no emojis, arrows or dashes used as punctuation
 * (CLAUDE.md rule 9); templates.test.ts lints them with every template.
 *
 * Marketing mail starts its footer with a line saying it is marketing, since
 * CAN-SPAM asks a commercial email to say it is an ad (docs/marketing.md
 * guardrail 5), then the plan's reason and one click unsubscribe line and
 * the postal address (founder decision 4).
 */

/** The first footer line of every marketing email. */
export const MARKETING_NOTICE = "This is a marketing email from Curvi.";

/** Why an account holder gets marketing mail. */
export const MARKETING_REASON = "You get this because you signed up at curvi.ai.";

/** Why a lead gets marketing mail: they ticked the consent box on a free
 * tool, or asked to hear when packs are back (P18-03 waitlist). */
export const LEAD_MARKETING_REASON = "You get this because you left your email on curvi.ai and asked to hear from Curvi.";

export const UNSUBSCRIBE_LINE = "Unsubscribe in one click:";

/** "Curvi, {postal address}" */
export function postalLine(address: string): string {
  return `Curvi, ${address}`;
}

/** Why a reader with an account gets a transactional email. */
export const ACCOUNT_REASON = "You get this email because you have a Curvi account.";

/** Why a reader without an account gets a transactional email. No lead
 * template is transactional today (lead_results and packs_back to a lead
 * are marketing); the line stays true for any that becomes one. */
export const LEAD_REASON = "You get this email because you left your email on curvi.ai.";

/** The sign off when no founder name is set. */
export const DEFAULT_SIGN_OFF = "Curvi";

/** Every fixed line above, for the copy lint. */
export const fixedEmailCopy: readonly string[] = [
  MARKETING_NOTICE,
  MARKETING_REASON,
  LEAD_MARKETING_REASON,
  UNSUBSCRIBE_LINE,
  postalLine("PO Box 100, Springfield, IL 62701"),
  ACCOUNT_REASON,
  LEAD_REASON,
  DEFAULT_SIGN_OFF,
];
