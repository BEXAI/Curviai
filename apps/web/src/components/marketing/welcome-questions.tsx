"use client";

import { useState } from "react";
import { Button, buttonVariants } from "@curvi/ui";

export interface WelcomeQuestionsProps {
  /** Where "continue" goes: /app/new, or the page the user was heading to. */
  continueHref: string;
  continueLabel: string;
  categories: readonly { key: string; label: string }[];
  channels: readonly { value: string; label: string }[];
  /** Preselected by a category or channel page (?category=, ?channel=). */
  initialCategory: string | null;
  initialChannels: readonly string[];
}

/** The copy, in one place for the copy lint (CLAUDE.md rule 9). */
export const WELCOME_QUESTIONS_COPY = {
  intro: "Two quick questions so your first pack fits. You can skip them.",
  category: "What do you sell?",
  channels: "Where do you sell?",
  channelsHelp: "Pick any that apply.",
  skip: "Skip the questions",
  dashboard: "Go to your dashboard",
} as const;

function chipClass(on: boolean): string {
  return (
    "rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-brand " +
    (on ? "border-teal-brand bg-teal-brand text-ink-950" : "border-white/30 bg-white/5 text-white/90 hover:bg-white/10")
  );
}

/**
 * The two optional first run questions on /welcome (docs/phases/PHASE_18.md
 * P18-20). Continuing saves what was picked (PUT
 * /api/workspace/seller-profile) and then goes on, whether or not the save
 * worked: the answers only preselect channels, so a failed save never holds
 * a seller up. Skip hides the questions and saves nothing.
 */
export function WelcomeQuestions({
  continueHref,
  continueLabel,
  categories,
  channels,
  initialCategory,
  initialChannels,
}: WelcomeQuestionsProps) {
  const [category, setCategory] = useState<string | null>(initialCategory);
  const [picked, setPicked] = useState<string[]>([...initialChannels]);
  const [skipped, setSkipped] = useState(false);
  const [busy, setBusy] = useState(false);

  function toggleChannel(value: string) {
    setPicked((current) => (current.includes(value) ? current.filter((v) => v !== value) : [...current, value]));
  }

  async function go(href: string) {
    setBusy(true);
    if (!skipped && (category !== null || picked.length > 0)) {
      try {
        await fetch("/api/workspace/seller-profile", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ category, channels: picked }),
        });
      } catch {
        // The answers are optional; go on without them.
      }
    }
    window.location.assign(href);
  }

  return (
    <div className="mt-8 text-left">
      {skipped ? null : (
        <div data-testid="welcome-questions" className="rounded-2xl border border-white/15 bg-white/5 p-5">
          <p className="text-sm text-white/80">{WELCOME_QUESTIONS_COPY.intro}</p>
          <fieldset className="mt-4">
            <legend className="text-sm font-semibold text-white">{WELCOME_QUESTIONS_COPY.category}</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {categories.map((choice) => (
                <button
                  key={choice.key}
                  type="button"
                  aria-pressed={category === choice.key}
                  data-testid={`welcome-category-${choice.key}`}
                  className={chipClass(category === choice.key)}
                  onClick={() => setCategory(category === choice.key ? null : choice.key)}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="mt-5">
            <legend className="text-sm font-semibold text-white">{WELCOME_QUESTIONS_COPY.channels}</legend>
            <p className="text-xs text-white/60">{WELCOME_QUESTIONS_COPY.channelsHelp}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {channels.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  aria-pressed={picked.includes(choice.value)}
                  data-testid={`welcome-channel-${choice.value}`}
                  className={chipClass(picked.includes(choice.value))}
                  onClick={() => toggleChannel(choice.value)}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </fieldset>
          <button
            type="button"
            data-testid="welcome-skip"
            className="mt-4 text-sm font-medium text-white/70 underline hover:text-white"
            onClick={() => setSkipped(true)}
          >
            {WELCOME_QUESTIONS_COPY.skip}
          </button>
        </div>
      )}
      <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Button
          type="button"
          variant="secondary"
          size="lg"
          disabled={busy}
          data-testid="welcome-continue"
          onClick={() => void go(continueHref)}
        >
          {continueLabel}
        </Button>
        <button
          type="button"
          disabled={busy}
          className={buttonVariants({ variant: "ghost", size: "lg", className: "text-white/85 hover:bg-white/10 hover:text-white" })}
          onClick={() => void go("/app")}
        >
          {WELCOME_QUESTIONS_COPY.dashboard}
        </button>
      </div>
    </div>
  );
}
