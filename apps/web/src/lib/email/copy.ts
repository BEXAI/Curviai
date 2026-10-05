/**
 * Visitor and seller facing copy for lifecycle email (docs/phases/PHASE_18.md
 * P18-06): the consent box on the free tool email gate and the packs paused
 * waitlist, the unsubscribe page and the settings toggle. Plain spoken, no
 * emojis, arrows or dashes used as punctuation (CLAUDE.md rule 9);
 * email-copy.test.ts lints every string here.
 */

/** The unticked box beside an email field (founder decision 5: only leads
 * who tick it ever get tips or offers). */
export const MARKETING_CONSENT_LABEL = "Also send me tips on listing images and the occasional offer";

/** Which wording of MARKETING_CONSENT_LABEL a consent was given under: the
 * date it was first shown. Stored with each consent (leads.consent_source,
 * "<tool>@<version>"), so the record shows what the visitor ticked. Change
 * it in the same commit as any change to the label. */
export const MARKETING_CONSENT_VERSION = "2026-10-01";

export const UNSUBSCRIBE_TITLE = "Unsubscribe";
export const UNSUBSCRIBE_QUESTION = "Stop tips and offers from Curvi? You will still get emails about packs you make and payments.";
export const UNSUBSCRIBE_BUTTON = "Unsubscribe";
export const UNSUBSCRIBE_BUSY = "Unsubscribing";
export const UNSUBSCRIBE_DONE = "You are unsubscribed. Curvi will not send you tips or offers again.";
export const UNSUBSCRIBE_FAILED = "We could not save that just now. Try again in a minute, or reply to any Curvi email and we will do it by hand.";
export const UNSUBSCRIBE_INVALID =
  "This unsubscribe link is not valid. Use the link in the email you got, or reply to that email and we will unsubscribe you by hand.";
export const UNSUBSCRIBE_HOME_LINK = "Back to the home page";

/** The settings card (P18-06). */
export const EMAIL_SETTINGS_TITLE = "Emails";
export const EMAIL_SETTINGS_LABEL = "Emails from Curvi with listing image tips and offers";
export const EMAIL_SETTINGS_HELP = "Emails about packs you make and payments always come.";
export const EMAIL_SETTINGS_SAVED_ON = "Saved. Curvi may send you tips and offers.";
export const EMAIL_SETTINGS_SAVED_OFF = "Saved. Curvi will not send you tips or offers.";
export const EMAIL_SETTINGS_BLOCKED =
  "Email to your address bounced or was marked as spam, so Curvi stopped all email to it. Write to support@curvi.ai to turn it back on.";
export const EMAIL_SETTINGS_FAILED = "We could not save that just now. Try again in a minute.";
export const EMAIL_SETTINGS_NO_ACCOUNT = "Sign in to change your email settings.";

/** Every string above, for the copy lint. */
export const emailCopyTexts: readonly string[] = [
  MARKETING_CONSENT_LABEL,
  UNSUBSCRIBE_TITLE,
  UNSUBSCRIBE_QUESTION,
  UNSUBSCRIBE_BUTTON,
  UNSUBSCRIBE_BUSY,
  UNSUBSCRIBE_DONE,
  UNSUBSCRIBE_FAILED,
  UNSUBSCRIBE_INVALID,
  UNSUBSCRIBE_HOME_LINK,
  EMAIL_SETTINGS_TITLE,
  EMAIL_SETTINGS_LABEL,
  EMAIL_SETTINGS_HELP,
  EMAIL_SETTINGS_SAVED_ON,
  EMAIL_SETTINGS_SAVED_OFF,
  EMAIL_SETTINGS_BLOCKED,
  EMAIL_SETTINGS_FAILED,
  EMAIL_SETTINGS_NO_ACCOUNT,
];
