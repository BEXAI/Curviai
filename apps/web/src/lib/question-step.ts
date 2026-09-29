/**
 * The question step on the new pack form (docs/phases/PHASE_16.md
 * workstream 4, founder decision 7): beside the note field, skippable, never
 * blocking submit. Pure, so the rules are unit tested without React:
 *
 * - which photo's questions the form shows (the front photo first);
 * - which of them are already known on the form (withoutKnown);
 * - what a target or channels tap changes on the form;
 * - what the pack request carries: ids and values only, resolved again on
 *   the server against the stored questions.
 */

import {
  channelSpecsForAnswer,
  withoutKnown,
  type QuestionKind,
  type SellerQuestion,
} from "@curvi/pipeline/questions";
import { questionSet } from "@curvi/pipeline/seed";
import type { PreflightView } from "@/lib/preflight/types";

export const QUESTION_STEP_COPY = {
  intro: questionSet.intro,
  skip: questionSet.skipLabel,
  prompts: questionSet.prompts,
  /** The link that brings a skipped step back. */
  reopen: "Answer the quick questions",
} as const;

/** The photo fields the step reads. */
export interface QuestionPhoto {
  id: number;
  kind: "image" | "video";
  phase: "uploading" | "uploaded" | "error";
  angle: string;
  key?: string;
  preflightPhase?: "checking" | "done" | "failed";
  preflight?: PreflightView | null;
  chosen?: number | null;
  /** The seller answered "Both" or "All of them" to the target question. */
  targetAll?: boolean;
}

/** The photo whose questions the step shows: the front photo when it has
 * any, else the first checked photo that does. */
export function questionSourcePhoto<T extends QuestionPhoto>(photos: readonly T[]): T | null {
  const asking = photos.filter(
    (p) =>
      p.kind === "image" &&
      p.phase === "uploaded" &&
      !!p.key &&
      p.preflightPhase === "done" &&
      (p.preflight?.questions?.length ?? 0) > 0,
  );
  return asking.find((p) => p.angle === "front") ?? asking[0] ?? null;
}

/** What the form already knows, so the step never asks it: a photo shown
 * in the box keeps every item, and a picked scene style (or scenes off)
 * settles the mood. */
export function knownKinds(args: {
  photoAngle: string;
  /** Output options are on for this pack. */
  optionsOn: boolean;
  scenesOn: boolean;
  scenePreset: string;
}): Partial<Record<QuestionKind, boolean>> {
  return {
    target: args.photoAngle === "in_the_box",
    mood: args.optionsOn && (!args.scenesOn || args.scenePreset !== "auto"),
  };
}

/** The questions the step shows, at most questionSet.maxQuestions. */
export function visibleQuestions(
  view: PreflightView | null | undefined,
  known: Partial<Record<QuestionKind, boolean>>,
): SellerQuestion[] {
  return withoutKnown(view?.questions ?? [], known).slice(0, questionSet.maxQuestions);
}

/** The target question's value as the photo holds it right now. */
export function targetValueOf(photo: Pick<QuestionPhoto, "chosen" | "targetAll">): string | null {
  if (photo.targetAll) return questionSet.allOption.value;
  return photo.chosen != null ? `item:${photo.chosen}` : null;
}

/** What a target tap sets on its photo: the chooser's pick, or every item. */
export function targetPickOf(value: string): { chosen: number | null; targetAll: boolean } | null {
  if (value === questionSet.allOption.value) return { chosen: null, targetAll: true };
  const match = /^item:(\d+)$/.exec(value);
  return match ? { chosen: Number(match[1]), targetAll: false } : null;
}

/** A tap's new value: tapping the option already held clears the answer,
 * so every question stays optional on its own. */
export function toggledAnswer(current: string | null | undefined, value: string): string | null {
  return current === value ? null : value;
}

/** What a target tap sets on its photo, clearing it when the tap took the
 * answer back (the chooser's rules then apply again). */
export function targetPatchFor(value: string | null): { chosen: number | null; targetAll: boolean } | null {
  return value === null ? { chosen: null, targetAll: false } : targetPickOf(value);
}

/**
 * What skipping the step undoes on its source photo. A skipped step sends no
 * answers, so "Both" must not linger as a hidden answer: the photo drops
 * targetAll and the chooser comes back asking for a tap. A single product
 * picked in the step stays, since the chooser shows and sends that pick.
 */
export function skipPatchFor(photo: Pick<QuestionPhoto, "targetAll"> | null): { targetAll: false } | null {
  return photo?.targetAll ? { targetAll: false } : null;
}

/**
 * The channels after a "Where will you sell?" tap: the marketplace picks
 * become the answer's specs (only pickable ones), every other pick stays.
 * The seller can still change any box afterwards.
 */
export function channelsAfterAnswer(
  selected: readonly string[],
  value: string,
  question: SellerQuestion,
  channel: (id: string) => { pickable: boolean; marketplace: boolean } | null,
): string[] {
  const offered = question.options.map((o) => o.value).filter((v) => v !== questionSet.allOption.value);
  const specs = channelSpecsForAnswer(value, offered).filter((id) => channel(id)?.pickable === true);
  if (specs.length === 0) return [...selected];
  const kept = selected.filter((id) => channel(id)?.marketplace !== true);
  return [...new Set([...kept, ...specs])];
}

/**
 * The seller answers the pack request carries: the source upload and the
 * picks that match a shown question's options (the target read from the
 * photo), or undefined when skipped or nothing was tapped.
 */
export function sellerAnswersBody(args: {
  photo: QuestionPhoto | null;
  questions: readonly SellerQuestion[];
  picks: Readonly<Record<string, string>>;
  skipped: boolean;
}): { key: string; picks: Record<string, string> } | undefined {
  const { photo, questions } = args;
  if (args.skipped || !photo?.key) return undefined;
  const out: Record<string, string> = {};
  for (const question of questions) {
    const value = question.kind === "target" ? targetValueOf(photo) : args.picks[question.id];
    if (value && question.options.some((o) => o.value === value)) {
      out[question.id] = value;
    }
  }
  return Object.keys(out).length > 0 ? { key: photo.key, picks: out } : undefined;
}
