/**
 * The question step before generating (docs/phases/PHASE_16.md workstream
 * 4). After upload the preflight asks at most four short questions with
 * labeled options ("Which product is this pack for? [Blue bottle] [Red
 * bottle] [Both]"), and the answers ride the pack as structured data that
 * outweighs the free text note.
 *
 * Deterministic first: openQuestionKinds leaves out every kind the photo or
 * the note already answers, before any model is asked. The question_planner
 * recipe then picks among the open kinds, and finalizeQuestions keeps only
 * what the seed and the photo allow: target options are always the photo's
 * own items, channel and mood options are always seed choices, and only the
 * use and audience labels are the model's words, checked for plain letters.
 * When the model is down the deterministic set (target, channels, mood) is
 * asked instead.
 *
 * Answers are resolved on the server against the stored questions
 * (resolveSellerAnswers), stored as generation_jobs.seller_answers and read
 * back with the shared SellerAnswers schema. The runner feeds them to
 * chooseInventoryTarget (answerSignals in inventory.ts), the seller intent
 * (intentWithAnswers) and the scene planner (profileWithAnswers,
 * applySceneAnswers, answerScenePreset).
 *
 * Client safe: zod, the seed and types only, so the new pack form imports
 * it through @curvi/pipeline/questions.
 */

import { z } from "zod";
import type { InventoryRule } from "./inventory";
import type { ProductProfile, SellerIntent, ShotList } from "./schemas";
import {
  channelChoices,
  defaultChannelChoices,
  defaultMoodChoices,
  moodChoices,
  QUESTION_KINDS,
  questionSet,
  type ChannelChoice,
  type MoodChoice,
  type QuestionKind,
} from "./seed/questions";
import type { PresetKey } from "./seed/templates";

export { QUESTION_KINDS, type QuestionKind };

// ---------------------------------------------------------------------------
// Questions.

export const QuestionOption = z.object({
  value: z.string().min(1).max(40),
  label: z.string().min(1).max(120),
  /** Target options only: the item's measured color name, so the answer
   * also finds the product on the pack's other photos. */
  color: z.string().max(16).optional(),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

export const SellerQuestion = z.object({
  /** Stable within one preflight; the kind, as one kind is asked once. */
  id: z.string().min(1).max(40),
  kind: z.enum(QUESTION_KINDS),
  options: z.array(QuestionOption).min(2).max(8),
});
export type SellerQuestion = z.infer<typeof SellerQuestion>;

/** The question_planner answer, sent as the strict tool schema. */
export const QuestionPlanTool = z.object({
  questions: z
    .array(
      z.object({
        id: z.string().max(40),
        kind: z.enum(QUESTION_KINDS),
        options: z.array(z.object({ value: z.string().max(40), label: z.string().max(40) })).max(8),
      }),
    )
    .max(4),
});

/** The planner answer as it is read: loose, since finalizeQuestions caps
 * and filters everything itself, so a long list or an unknown kind costs
 * one question, not the whole step. */
export const QuestionPlanAnswer = z.object({
  questions: z.array(
    z.object({
      id: z.string().optional(),
      kind: z.string(),
      options: z.array(z.object({ value: z.string(), label: z.string() })).default([]),
    }),
  ),
});

/** One product the photo holds, in chooser order (1 based). */
export interface QuestionItem {
  number: number;
  label: string;
  colorName: string;
}

export interface QuestionContext {
  /** The photo holds several products and nothing said which one. */
  targetOpen: boolean;
  note?: string | null;
  intent?: SellerIntent | null;
}

/** Whether the target question is open for a photo: the chooser would show
 * (minItems to maxItems pieces) and the rules could not settle the product. */
export function targetQuestionOpen(
  rule: InventoryRule | null,
  items: number,
  range: { min: number; max: number },
): boolean {
  return (rule === "ambiguous" || rule === "conflict") && items >= range.min && items <= range.max;
}

function lettersOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 0);
}

/**
 * The kinds of question still open, in QUESTION_KINDS order: none the photo
 * or the note already answers.
 *
 * - target: only when targetOpen (several products and no pick).
 * - channels: unless the note names a marketplace of channelChoices.
 * - mood: unless the note names a mood of moodChoices or says anything
 *   about the look (intake's styleNotes).
 * - use and audience: unless the note says anything about the look.
 *
 * Remembered choices are left out on the form (withoutKnown), since they
 * belong to the product the seller picks there.
 */
export function openQuestionKinds(ctx: QuestionContext): QuestionKind[] {
  const words = new Set(
    lettersOf([ctx.note ?? "", ctx.intent?.featureOnly ?? "", ctx.intent?.styleNotes ?? ""].join(" ").slice(0, 3000)),
  );
  const names = (keywords: readonly string[]) => keywords.some((k) => words.has(k));
  const styled = !!ctx.intent?.styleNotes?.trim();
  const open: QuestionKind[] = [];
  if (ctx.targetOpen) open.push("target");
  if (!channelChoices.some((c) => names(c.keywords))) open.push("channels");
  if (!styled && !moodChoices.some((m) => names(m.keywords))) open.push("mood");
  if (!styled) open.push("use", "audience");
  return open;
}

/** The questions left once the form's known choices are taken out. */
export function withoutKnown(
  questions: readonly SellerQuestion[],
  known: Partial<Record<QuestionKind, boolean>>,
): SellerQuestion[] {
  return questions.filter((q) => !known[q.kind]);
}

function allOption(count: number): QuestionOption {
  const all = questionSet.allOption;
  return { value: all.value, label: count === 2 ? all.twoLabel : all.manyLabel };
}

/** The target question: every item of the photo, then the whole set. */
export function targetQuestion(items: readonly QuestionItem[]): SellerQuestion | null {
  if (items.length < questionSet.minOptions) return null;
  return {
    id: "target",
    kind: "target",
    options: [
      ...items.map((item) => ({
        value: `item:${item.number}`,
        label: item.label.slice(0, 120),
        color: item.colorName.slice(0, 16),
      })),
      allOption(items.length),
    ],
  };
}

function channelQuestion(values: readonly string[]): SellerQuestion {
  const picked = uniqueChoices(values, channelChoices).slice(0, questionSet.maxOptions - 1);
  const choices = picked.length >= questionSet.minOptions ? picked : uniqueChoices(defaultChannelChoices, channelChoices);
  return {
    id: "channels",
    kind: "channels",
    options: [...choices.map((c) => ({ value: c.value, label: c.label })), allOption(choices.length)],
  };
}

function moodQuestion(values: readonly string[]): SellerQuestion {
  const picked = uniqueChoices(values, moodChoices).slice(0, questionSet.maxOptions);
  const choices = picked.length >= questionSet.minOptions ? picked : uniqueChoices(defaultMoodChoices, moodChoices);
  return { id: "mood", kind: "mood", options: choices.map((c) => ({ value: c.value, label: c.label })) };
}

function uniqueChoices<T extends { value: string }>(values: readonly string[], catalog: readonly T[]): T[] {
  return [...new Set(values)].flatMap((v) => catalog.filter((c) => c.value === v));
}

/** A model written option label, kept only as one to a few plain words:
 * letters and spaces, at most questionSet.optionLabelMax. Null otherwise. */
export function plainOptionLabel(text: string): string | null {
  const cleaned = text
    .replace(/[^A-Za-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0 || cleaned.length > questionSet.optionLabelMax) return null;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function freeQuestion(kind: "use" | "audience", options: ReadonlyArray<{ label: string }>): SellerQuestion | null {
  const seen = new Set<string>();
  const out: QuestionOption[] = [];
  for (const option of options) {
    const label = plainOptionLabel(option.label);
    if (!label) continue;
    const value = label.toLowerCase().replace(/ /g, "_");
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ value, label });
  }
  const kept = out.slice(0, questionSet.maxOptions);
  return kept.length >= questionSet.minOptions ? { id: kind, kind, options: kept } : null;
}

/** The questions asked without the model: target, channels and mood, when
 * open, with seed options. */
export function deterministicQuestions(
  open: readonly QuestionKind[],
  items: readonly QuestionItem[],
): SellerQuestion[] {
  const out: SellerQuestion[] = [];
  for (const kind of QUESTION_KINDS) {
    if (!open.includes(kind)) continue;
    const question =
      kind === "target"
        ? targetQuestion(items)
        : kind === "channels"
          ? channelQuestion(defaultChannelChoices)
          : kind === "mood"
            ? moodQuestion(defaultMoodChoices)
            : null;
    if (question) out.push(question);
  }
  return out.slice(0, questionSet.maxQuestions);
}

/**
 * The questions the seller sees from a question_planner answer: open kinds
 * only, each once, the target first (always asked when open, with the
 * photo's own items), at most questionSet.maxQuestions. A null or out of
 * shape answer gives the deterministic set.
 */
export function finalizeQuestions(
  raw: unknown,
  open: readonly QuestionKind[],
  items: readonly QuestionItem[],
): SellerQuestion[] {
  const parsed = raw === null || raw === undefined ? null : QuestionPlanAnswer.safeParse(raw);
  if (!parsed?.success) {
    return deterministicQuestions(open, items);
  }
  const byKind = new Map<QuestionKind, SellerQuestion>();
  if (open.includes("target")) {
    const target = targetQuestion(items);
    if (target) byKind.set("target", target);
  }
  for (const q of parsed.data.questions) {
    const kind = QUESTION_KINDS.find((k) => k === q.kind);
    if (!kind || !open.includes(kind) || byKind.has(kind)) continue;
    const values = q.options.map((o) => o.value);
    const question =
      kind === "target"
        ? null
        : kind === "channels"
          ? channelQuestion(values)
          : kind === "mood"
            ? moodQuestion(values)
            : freeQuestion(kind, q.options);
    if (question) byKind.set(kind, question);
  }
  return [...byKind.values()].slice(0, questionSet.maxQuestions);
}

/** What the model is told about the seed choices it may offer. */
export function questionPlannerChoices(): {
  channelChoices: Array<{ value: string; label: string }>;
  moodChoices: Array<{ value: string; label: string }>;
} {
  return {
    channelChoices: channelChoices.map((c) => ({ value: c.value, label: c.label })),
    moodChoices: moodChoices.map((m) => ({ value: m.value, label: m.label })),
  };
}

// ---------------------------------------------------------------------------
// Answers.

const Choice = z.object({
  value: z.string().min(1).max(40),
  label: z.string().min(1).max(120),
});

export const TargetAnswer = z.object({
  /** "item:N" for one product, or "all" for every product. */
  value: z.string().min(1).max(40),
  label: z.string().min(1).max(120),
  /** The picked item's measured color name, null for "all". */
  color: z.string().max(16).nullable(),
  /** The other items' labels: left out of every image. */
  others: z.array(z.string().max(120)).max(8),
});
export type TargetAnswer = z.infer<typeof TargetAnswer>;

/** generation_jobs.seller_answers (migration 0024). */
export const SellerAnswers = z.object({
  version: z.literal(1),
  target: TargetAnswer.optional(),
  channels: Choice.optional(),
  mood: Choice.optional(),
  use: Choice.optional(),
  audience: Choice.optional(),
});
export type SellerAnswers = z.infer<typeof SellerAnswers>;

/** The taps the form sends: question id to option value. */
export const SellerAnswerPicks = z
  .record(z.string().min(1).max(40), z.string().min(1).max(40))
  .refine((picks) => Object.keys(picks).length <= QUESTION_KINDS.length, "Too many answers.");
export type SellerAnswerPicks = z.infer<typeof SellerAnswerPicks>;

/** Stored answers read back, or null when there are none or they are out
 * of shape (answers only ever help; a pack never fails on them). */
export function parseSellerAnswers(raw: unknown): SellerAnswers | null {
  if (raw === null || raw === undefined) return null;
  const parsed = SellerAnswers.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** True when the answer names one product (not the whole set). */
export function isItemTarget(target: TargetAnswer | undefined): target is TargetAnswer {
  return !!target && target.value !== questionSet.allOption.value;
}

/**
 * The seller's taps resolved against the questions the server stored: an
 * unknown question or a value that is not one of its options is dropped,
 * so every label on the job is the server's, never the client's. Null when
 * nothing is left.
 */
export function resolveSellerAnswers(
  questions: readonly SellerQuestion[],
  picks: Readonly<Record<string, string>>,
): SellerAnswers | null {
  const out: SellerAnswers = { version: 1 };
  let any = false;
  for (const question of questions) {
    const value = picks[question.id];
    const option = value === undefined ? undefined : question.options.find((o) => o.value === value);
    if (!option) continue;
    any = true;
    if (question.kind === "target") {
      const all = option.value === questionSet.allOption.value;
      out.target = {
        value: option.value,
        label: option.label,
        color: all ? null : (option.color ?? null),
        others: all
          ? []
          : question.options
              .filter((o) => o.value !== option.value && o.value !== questionSet.allOption.value)
              .map((o) => o.label),
      };
    } else {
      out[question.kind] = { value: option.value, label: option.label };
    }
  }
  return any ? out : null;
}

/** The registry spec ids a channels answer ticks: one family, or every
 * family the question offered for "all". */
export function channelSpecsForAnswer(value: string, offered: readonly string[]): string[] {
  const values = value === questionSet.allOption.value ? offered : [value];
  return channelChoices.filter((c: ChannelChoice) => values.includes(c.value)).flatMap((c) => [...c.specs]);
}

export function moodChoiceOf(answers: SellerAnswers | null | undefined): MoodChoice | null {
  const value = answers?.mood?.value;
  return value ? (moodChoices.find((m) => m.value === value) ?? null) : null;
}

/** The scene style an answered mood sets, or null. */
export function answerScenePreset(answers: SellerAnswers | null | undefined): PresetKey | null {
  return moodChoiceOf(answers)?.preset ?? null;
}

/** The lifestyle scenes the answers ask for, first to last: the mood's seed
 * scene, then where the product is used. */
export function answerScenes(answers: SellerAnswers | null | undefined): string[] {
  const scenes: string[] = [];
  const mood = moodChoiceOf(answers);
  if (mood) scenes.push(mood.scene);
  const use = answers?.use ? plainOptionLabel(answers.use.label) : null;
  if (use) scenes.push(`${use.toLowerCase()} setting`);
  return scenes;
}

/**
 * The product profile with the answers ahead of what the analyzer guessed:
 * the answered scenes lead useContexts (both planners plan scenes from them,
 * contexts first), and an answered audience is the target buyer.
 */
export function profileWithAnswers(profile: ProductProfile, answers: SellerAnswers | null | undefined): ProductProfile {
  if (!answers) return profile;
  const scenes = answerScenes(answers);
  const audience = answers.audience ? plainOptionLabel(answers.audience.label) : null;
  if (scenes.length === 0 && !audience) return profile;
  return {
    ...profile,
    useContexts: [...new Set([...scenes, ...profile.useContexts])].slice(0, 6),
    ...(audience ? { targetBuyer: audience } : {}),
  };
}

/**
 * Makes sure the plan's first lifestyle scenes are the answered ones,
 * whichever planner made it: the LLM planner may have ranked the analyzer's
 * contexts first. Only the scene text changes, never a shot's type, price
 * or channels, so the hold and the plan stay the same size.
 */
export function applySceneAnswers(plan: ShotList, answers: SellerAnswers | null | undefined): ShotList {
  const wanted = answerScenes(answers);
  if (wanted.length === 0) return plan;
  const lifestyle = plan.shots.map((s, i) => ({ s, i })).filter(({ s }) => s.type === "lifestyle");
  const used = new Set(lifestyle.map(({ s }) => s.scene));
  const missing = wanted.filter((scene) => !used.has(scene));
  if (missing.length === 0) return plan;
  // The answered scenes take the slots of scenes that are not answers, first first.
  const free = lifestyle.filter(({ s }) => !wanted.includes(s.scene ?? ""));
  const shots = [...plan.shots];
  missing.forEach((scene, n) => {
    const slot = free[n];
    if (slot) shots[slot.i] = { ...slot.s, scene };
  });
  return { ...plan, shots };
}

/**
 * The seller intent with the answers over the note: a picked product is the
 * one to feature and the photo's other items are left out; "all" features
 * every product; mood, use and audience lead the style notes. The note's own
 * exclusions stay unless they name the picked product. Null only when there
 * is neither an intent nor an answer.
 */
export function intentWithAnswers(
  intent: SellerIntent | null | undefined,
  answers: SellerAnswers | null | undefined,
): SellerIntent | null {
  if (!answers) return intent ?? null;
  const base: SellerIntent = intent ?? { featureOnly: null, exclude: [], mustKeep: [], styleNotes: null };
  const phrase = (text: string) => lettersOf(text).join(" ");
  const target = answers.target;
  let featureOnly = base.featureOnly;
  let exclude = base.exclude;
  if (isItemTarget(target)) {
    featureOnly = target.label.slice(0, 120);
    exclude = [...new Set([...target.others, ...base.exclude.filter((e) => phrase(e) !== phrase(target.label))])]
      .map((e) => e.slice(0, 120))
      .slice(0, 8);
  } else if (target) {
    featureOnly = null;
  }
  const lines = [
    answers.mood ? `Scene mood: ${answers.mood.label}.` : null,
    answers.use ? `Used for: ${answers.use.label}.` : null,
    answers.audience ? `For: ${answers.audience.label}.` : null,
  ].filter((line): line is string => line !== null);
  const styleNotes = [...lines, base.styleNotes ?? ""].join(" ").trim().slice(0, 400);
  return { ...base, featureOnly, exclude, styleNotes: styleNotes.length > 0 ? styleNotes : null };
}
