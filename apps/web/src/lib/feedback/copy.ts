/**
 * The words of pack feedback (docs/phases/PHASE_18.md P18-05). Plain spoken,
 * no emojis, no arrows and no dashes used as punctuation (CLAUDE.md rule 9);
 * feedback-copy.test.ts lints every string here.
 */

import { packFeedback } from "@curvi/pipeline/seed";

export const FEEDBACK_COPY = {
  title: "Would you use these files in a live listing?",
  intro: "One quick question about this pack. Your answer shapes what we fix next.",
  usable: {
    yes: "Yes, as they are",
    some: "Some of them",
    not_yet: "Not yet",
  },
  betterLabel: "What would make them better?",
  betterHint: "Optional. A sentence is plenty.",
  wouldPayLabel: "Would you pay for packs like this?",
  wouldPay: {
    yes: "Yes",
    maybe: "Maybe",
    no: "No",
  },
  consentLabel: "You can quote me on curvi.ai with this name and store:",
  consentHint: "We only quote your words above, with the name you type here. Leave it unticked to keep your answer private.",
  namePlaceholder: "Your name and store",
  send: "Send",
  sending: "Sending",
  dismiss: "Not now",
  thanks: "Thank you. Your answer helps us make the next pack better.",
  notYetThanks: "Thanks. We read every note and will email you if we can fix it.",
  already: "You already answered for this pack. Thank you.",
  pickUsable: "Pick one answer to the first question.",
  invalid: "Something in that answer did not look right. Check it and send again.",
  commentTooLong: `That is a bit long. Keep it to ${packFeedback.commentMaxChars} characters or fewer.`,
  nameTooLong: `Keep the name and store to ${packFeedback.displayNameMaxChars} characters or fewer.`,
  nameNotEmail: "Use a name and store, not an email address.",
  quoteNeedsWords: "Add a few words we can quote, or untick the box.",
  failed: "That did not send. Try again in a minute.",
  offline: "We could not reach Curvi. Check your connection and try again.",
  notReady: "This pack is not finished yet. You can answer once it is done.",
  notFound: "Pack not found.",
  signIn: "Sign in to answer for this pack.",
  linkPageTitle: "Your pack feedback",
  linkInvalid: "This feedback link has expired or is not valid. Open the pack in Curvi to answer there.",
  linkUnavailable: "Feedback links are not available right now. Open the pack in Curvi to answer there.",
  openPack: "Open the pack",
} as const;

/** Every user facing string above, for the lint test. */
export function allFeedbackCopy(): string[] {
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      out.push(value);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };
  walk(FEEDBACK_COPY);
  return out;
}
