"use client";

import { cn } from "@curvi/ui";
import type { SellerQuestion } from "@curvi/pipeline/questions";
import type { PreflightItemView } from "@/lib/preflight/types";
import { QUESTION_STEP_COPY } from "@/lib/question-step";

interface QuestionStepProps {
  questions: readonly SellerQuestion[];
  /** The source photo's items, for the target options' thumbnails. */
  items: readonly PreflightItemView[];
  /** The value each question holds right now, by question id. */
  values: Readonly<Record<string, string | null | undefined>>;
  onPick: (question: SellerQuestion, value: string) => void;
  onSkip: () => void;
}

function thumbFor(items: readonly PreflightItemView[], value: string): PreflightItemView | null {
  const match = /^item:(\d+)$/.exec(value);
  return match ? (items.find((item) => item.number === Number(match[1])) ?? null) : null;
}

/**
 * The question step (docs/phases/PHASE_16.md workstream 4): at most four
 * short questions with labeled options, beside the note field. Every
 * question is optional and "Skip, use my note" hides the step; nothing here
 * ever blocks Create pack.
 */
export function QuestionStep({ questions, items, values, onPick, onSkip }: QuestionStepProps) {
  if (questions.length === 0) return null;
  return (
    <section className="mt-3 rounded-lg border border-ink-200 bg-ink-50 p-3" aria-label="Quick questions" data-testid="question-step">
      <p className="text-sm text-ink-800">{QUESTION_STEP_COPY.intro}</p>
      <div className="mt-2 space-y-3">
        {questions.map((question) => {
          const prompt = QUESTION_STEP_COPY.prompts[question.kind];
          const current = values[question.id] ?? null;
          return (
            <div key={question.id} role="radiogroup" aria-label={prompt} data-testid={`question-${question.kind}`}>
              <p className="text-sm font-medium text-ink-900">{prompt}</p>
              <div className="mt-1 flex flex-wrap gap-2">
                {question.options.map((option) => {
                  const active = current === option.value;
                  const thumb = question.kind === "target" ? thumbFor(items, option.value) : null;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => onPick(question, option.value)}
                      className={cn(
                        "inline-flex min-h-11 items-center gap-2 rounded-full border bg-white px-3 py-1 text-sm transition-colors",
                        active ? "border-ink-900 ring-2 ring-ink-900" : "border-ink-200 hover:border-ink-400",
                      )}
                      data-testid={`question-${question.kind}-option`}
                    >
                      {thumb?.thumbUrl ? (
                        <img src={thumb.thumbUrl} alt="" width={32} height={32} className="h-8 w-8 rounded object-contain" />
                      ) : null}
                      <span>{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onSkip}
        className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-ink-700 underline"
        data-testid="question-skip"
      >
        {QUESTION_STEP_COPY.skip}
      </button>
    </section>
  );
}
