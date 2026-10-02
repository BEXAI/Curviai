/**
 * Copy for the acquisition gate (docs/phases/PHASE_18.md P18-03): what a
 * visitor sees while packs are paused. Plain spoken, no dashes used as
 * punctuation (CLAUDE.md rule 9); acquisition-copy.test.ts lints it.
 */

/** The Start free button's label while the gate is closed. */
export const WAITLIST_CTA_LABEL = "Get notified when packs are back";

/** The notice in the waitlist dialog. */
export const WAITLIST_NOTICE =
  "Packs are paused for a short while. Leave your email and we will tell you the moment they are back. The free checkers still work.";

export const WAITLIST_TITLE = "Packs are paused";
export const WAITLIST_SUBMIT = "Notify me";
export const WAITLIST_BUSY = "Saving";
export const WAITLIST_DONE = "Thanks. We will email you the moment packs are back.";
export const WAITLIST_CLOSE = "Close";
export const WAITLIST_TOOLS_LINK = "Try the free main image checker";

/** What the email is for. Narrower than the tools' notice on purpose: these
 * visitors asked to hear when packs are back, nothing more (decision 5). */
export const WAITLIST_PRIVACY = "We use your email to tell you when packs are back, and never sell it. Ask us to delete it any time.";

export const WAITLIST_SAVE_FAILED = "We could not save that just now. Try again in a minute.";
export const WAITLIST_OFFLINE = "We could not reach Curvi. Check your connection and try again.";

/** The /signup notice while the gate is closed. Signup stays open. */
export const SIGNUP_PAUSED_NOTICE =
  "Packs are paused right now. You can create your account today, and we will email you when packs are back.";

/** Every visitor facing string above, for the copy lint. */
export const acquisitionCopyTexts: readonly string[] = [
  WAITLIST_CTA_LABEL,
  WAITLIST_NOTICE,
  WAITLIST_TITLE,
  WAITLIST_SUBMIT,
  WAITLIST_BUSY,
  WAITLIST_DONE,
  WAITLIST_CLOSE,
  WAITLIST_TOOLS_LINK,
  WAITLIST_PRIVACY,
  WAITLIST_SAVE_FAILED,
  WAITLIST_OFFLINE,
  SIGNUP_PAUSED_NOTICE,
];
