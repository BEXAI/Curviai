/**
 * "Make this pack again" (docs/phases/PHASE_16.md workstream 6): a finished
 * pack's channels, output options (bundle and scene versions included),
 * question answers and note, read back into the new pack form as a prefill.
 *
 * A client prefill only, the same rule as the remembered choices of
 * PHASE_15: nothing here creates a job or reaches createJob. The form sends
 * whatever the seller then submits, and the server checks it as it checks
 * any pack: entitlements, the options schema, and the answers resolved again
 * against the questions stored for the upload. Pure, so the mapping is unit
 * tested without a database.
 */

import { QUESTION_KINDS, parseSellerAnswers, type QuestionKind, type SellerQuestion } from "@curvi/pipeline/questions";
import { longDate } from "@/lib/dates";
import { readStoredOutputOptions } from "@/lib/services/output-options";
import type { PackMode } from "@/lib/services/types";

/** Fields createJob adds when it resolves the options; never a choice. */
const RESOLVED_FIELDS = ["look", "colorHex", "brandSweepHex", "keepMediaIds"] as const;

/** What the form fills in from an earlier pack. */
export interface ReusePrefill {
  /** The pack it came from. */
  jobId: string;
  productId: string;
  mode: PackMode;
  channels: string[];
  /** The pack's choices in the request's shape (normalized, no resolved
   * snapshot), or null for a pack that used today's defaults or whose
   * stored options could not be read. The form reads it like remembered
   * choices (rememberedFormState) and fails closed. */
  outputOptions: Record<string, unknown> | null;
  /** The question step's answers by kind, as option values. The form taps
   * the matching option when the new upload's questions offer it. */
  answers: Partial<Record<QuestionKind, string>>;
  /** The seller's note on that pack, or empty. */
  note: string;
  createdAt: string;
}

/** The job columns the prefill reads. */
export interface ReuseJobRow {
  id: string;
  productId: string;
  mode: PackMode | null;
  channels: string[] | null;
  outputOptions: unknown;
  sellerAnswers: unknown;
  sellerNote: string | null;
  createdAt: Date;
}

/** The stored options as choices: the resolved snapshot fields left out. */
export function reuseOutputOptions(stored: unknown): Record<string, unknown> | null {
  const resolved = readStoredOutputOptions(stored);
  if (!resolved) {
    return null;
  }
  const choices: Record<string, unknown> = { ...resolved };
  for (const field of RESOLVED_FIELDS) {
    delete choices[field];
  }
  return choices;
}

/** The stored answers as option values by kind; empty when none. */
export function reuseAnswers(stored: unknown): Partial<Record<QuestionKind, string>> {
  const answers = parseSellerAnswers(stored);
  const out: Partial<Record<QuestionKind, string>> = {};
  if (!answers) {
    return out;
  }
  for (const kind of QUESTION_KINDS) {
    const value = answers[kind]?.value;
    if (typeof value === "string" && value.length > 0) {
      out[kind] = value;
    }
  }
  return out;
}

/** A job row as the form's prefill. */
export function reusePrefillOf(job: ReuseJobRow): ReusePrefill {
  return {
    jobId: job.id,
    productId: job.productId,
    mode: job.mode ?? "listing",
    channels: [...(job.channels ?? [])],
    outputOptions: reuseOutputOptions(job.outputOptions),
    answers: reuseAnswers(job.sellerAnswers),
    note: job.sellerNote ?? "",
    createdAt: job.createdAt.toISOString(),
  };
}

/**
 * The taps to preselect on the new upload's questions: for each question
 * the seller has not tapped yet whose kind the earlier pack answered, that
 * value when the question offers it. The target question is left alone,
 * since it names a product in one photo and the photo's chooser holds it.
 */
export function prefilledPicks(
  questions: readonly SellerQuestion[],
  answers: Partial<Record<QuestionKind, string>>,
  current: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = { ...current };
  for (const question of questions) {
    if (question.kind === "target" || out[question.id] !== undefined) {
      continue;
    }
    const value = answers[question.kind];
    if (value !== undefined && question.options.some((option) => option.value === value)) {
      out[question.id] = value;
    }
  }
  return out;
}

/** The link that opens the new pack form filled from this pack. */
export function reuseHref(jobId: string): string {
  return `/app/new?from=${encodeURIComponent(jobId)}`;
}

export const REUSE_LABEL = "Make this pack again";

/** The notice above a prefilled form. */
export function reuseNotice(createdAt: string): string {
  const day = longDate(createdAt);
  return day
    ? `Filled in from your pack of ${day}. Add a new photo or keep the same one, and change anything you like.`
    : "Filled in from an earlier pack. Add a new photo or keep the same one, and change anything you like.";
}
