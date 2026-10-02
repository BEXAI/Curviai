/**
 * Plain spoken sentences built from the legal facts (docs/phases/PHASE_20.md
 * P20-23), shared by the terms, privacy, subprocessors, help and settings
 * pages so each states the same thing.
 *
 * A fact the founder has not supplied yet (the legal entity, its address and
 * the governing law, decision 9) comes back as a PendingText, which the pages
 * render as a clearly marked pending line, never as invented text.
 *
 * Pure: takes the facts as an argument, so tests can pass both today's facts
 * and the ones a later lane sets.
 */

import type { LegalFacts } from "./facts";

/** A line the founder still has to supply. The pages mark it as pending. */
export interface PendingText {
  pending: string;
}

/** A sentence, or the pending line that stands in for it. */
export type LegalLine = string | PendingText;

export function isPending(line: LegalLine): line is PendingText {
  return typeof line !== "string";
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** "two" for 2; digits from 11 up. */
export function numberWord(n: number): string {
  return Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n]! : String(n);
}

/** "1 day", "30 days". */
export function countOf(n: number, unit: "day" | "year"): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** "October 1, 2026" for "2026-10-01". */
export function legalDate(isoDay: string): string {
  return new Date(`${isoDay}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** "two business days" (decision 24). */
export function supportReplyTime(facts: LegalFacts): string {
  const days = facts.support.replyBusinessDays;
  return `${numberWord(days)} business day${days === 1 ? "" : "s"}`;
}

/** "We reply within two business days." */
export function replySentence(facts: LegalFacts): string {
  return `We reply within ${supportReplyTime(facts)}.`;
}

/** Who runs Curvi, or the pending line until the founder supplies it. */
export function entitySentence(facts: LegalFacts): LegalLine {
  const { name, postalAddress } = facts.entity;
  if (!name || !postalAddress) {
    return {
      pending:
        "Pending: the legal name and postal address of the business that runs Curvi will be added here before paid plans open.",
    };
  }
  return `Curvi is run by ${name}, ${postalAddress}.`;
}

/** The governing law clause, or the pending line until it is chosen. */
export function governingLawSentence(facts: LegalFacts): LegalLine {
  const law = facts.entity.governingLaw;
  if (!law) {
    return { pending: "Pending: the law that governs these terms will be added here before paid plans open." };
  }
  return `These terms are governed by the laws of ${law}.`;
}

/** The annual renewal reminder promise, or null before P20-07 sets the window. */
export function annualReminderSentence(facts: LegalFacts): string | null {
  const window = facts.annualRenewalReminderDays;
  if (!window) {
    return null;
  }
  const [earliest, latest] = window;
  return `For a yearly plan, we also email you ${earliest} to ${latest} days before each renewal.`;
}

/** The notice the terms promise before a material change. */
export function termsChangeSentence(facts: LegalFacts): string {
  return `We may update these terms. If a change affects what you pay or how you use Curvi, we email you at least ${countOf(facts.termsChangeNoticeDays, "day")} before it applies.`;
}

/** The facts the founder still has to supply before live keys (decision 9). */
export function pendingLegalFacts(facts: LegalFacts): string[] {
  const missing: string[] = [];
  if (!facts.entity.name) missing.push("entity.name");
  if (!facts.entity.postalAddress) missing.push("entity.postalAddress");
  if (!facts.entity.governingLaw) missing.push("entity.governingLaw");
  return missing;
}
