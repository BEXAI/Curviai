/**
 * Pack feedback (docs/phases/PHASE_18.md P18-05), the client safe part: the
 * answer shapes, the status the card reads, and the one validator the
 * routes, the card and the signed link page share. The caps come from the
 * seed (growth.ts packFeedback), and the pack_feedback checks hold the same
 * limits in the database.
 */

import { packFeedback } from "@curvi/pipeline/seed";
import { FEEDBACK_COPY } from "./copy";

export const USABLE_ANSWERS = ["yes", "some", "not_yet"] as const;
export const WOULD_PAY_ANSWERS = ["yes", "maybe", "no"] as const;

export type UsableAnswer = (typeof USABLE_ANSWERS)[number];
export type WouldPayAnswer = (typeof WOULD_PAY_ANSWERS)[number];

/** One answer, cleaned. */
export interface FeedbackAnswer {
  usable: UsableAnswer;
  wouldPay: WouldPayAnswer | null;
  comment: string | null;
  quoteConsent: boolean;
  displayName: string | null;
}

/** What the card needs to know about one pack for the signed in person. */
export interface FeedbackStatus {
  jobId: string;
  /** True once the pack is done. */
  eligible: boolean;
  /** True when this person already answered for this pack. */
  answered: boolean;
}

/** Where an answer came from, for the funnel step's props. */
export type FeedbackVia = "pack_page" | "email_link";

export type FeedbackSubmitOutcome =
  | { outcome: "saved"; status: FeedbackStatus }
  | { outcome: "already"; status: FeedbackStatus }
  | { outcome: "rejected"; reason: "not_found" | "not_ready"; message: string };

export type FeedbackValidation = { ok: true; answer: FeedbackAnswer } | { ok: false; message: string };

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/** Free text with control characters dropped and spaces trimmed; null when
 * empty, or when it is longer than max (the caller refuses that). */
function cleanText(raw: unknown, max: number, oneLine: boolean): { value: string | null; tooLong: boolean } {
  if (raw === undefined || raw === null) {
    return { value: null, tooLong: false };
  }
  if (typeof raw !== "string") {
    return { value: null, tooLong: false };
  }
  let value = raw.replace(CONTROL, oneLine ? " " : "");
  value = oneLine ? value.replace(/\s+/g, " ").trim() : value.replace(/\r\n?/g, "\n").trim();
  if (value.length === 0) {
    return { value: null, tooLong: false };
  }
  return { value, tooLong: value.length > max };
}

/**
 * Checks and cleans an answer from any caller: the usable answer must be
 * one of the three, would pay one of three or empty, the comment at most
 * packFeedback.commentMaxChars, the name one line of at most
 * packFeedback.displayNameMaxChars and never an email address, and a quote
 * consent needs words to quote. The name is kept only with the consent.
 */
export function validateFeedbackAnswer(raw: unknown): FeedbackValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: FEEDBACK_COPY.pickUsable };
  }
  const body = raw as Record<string, unknown>;
  if (!isOneOf(USABLE_ANSWERS, body.usable)) {
    return { ok: false, message: FEEDBACK_COPY.pickUsable };
  }
  const wouldPay = body.wouldPay === undefined || body.wouldPay === null || body.wouldPay === "" ? null : body.wouldPay;
  if (wouldPay !== null && !isOneOf(WOULD_PAY_ANSWERS, wouldPay)) {
    return { ok: false, message: FEEDBACK_COPY.invalid };
  }
  const comment = cleanText(body.comment, packFeedback.commentMaxChars, false);
  if (comment.tooLong) {
    return { ok: false, message: FEEDBACK_COPY.commentTooLong };
  }
  const quoteConsent = body.quoteConsent === true;
  const name = cleanText(body.displayName, packFeedback.displayNameMaxChars, true);
  if (quoteConsent && name.tooLong) {
    return { ok: false, message: FEEDBACK_COPY.nameTooLong };
  }
  if (quoteConsent && name.value && EMAIL_LIKE.test(name.value)) {
    return { ok: false, message: FEEDBACK_COPY.nameNotEmail };
  }
  if (quoteConsent && !comment.value) {
    return { ok: false, message: FEEDBACK_COPY.quoteNeedsWords };
  }
  return {
    ok: true,
    answer: {
      usable: body.usable,
      wouldPay: wouldPay as WouldPayAnswer | null,
      comment: comment.value,
      quoteConsent,
      displayName: quoteConsent ? name.value : null,
    },
  };
}
