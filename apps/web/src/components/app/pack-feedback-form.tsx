"use client";

import { useState } from "react";
import { Button, Input, Textarea, cn } from "@curvi/ui";
import { packFeedback } from "@curvi/pipeline/seed";
import { FEEDBACK_COPY } from "@/lib/feedback/copy";
import {
  USABLE_ANSWERS,
  WOULD_PAY_ANSWERS,
  validateFeedbackAnswer,
  type FeedbackStatus,
  type UsableAnswer,
  type WouldPayAnswer,
} from "@/lib/feedback/types";
import { track } from "@/lib/track";

export interface PackFeedbackFormProps {
  /** Where the answer is posted: /api/jobs/{id}/feedback or /api/feedback/{token}. */
  endpoint: string;
  /** A stable prefix for the radio group names. */
  idPrefix: string;
  /** Called once the answer is saved (or was already saved). */
  onDone: (status: FeedbackStatus | null, notice: string) => void;
}

function Choice<T extends string>({
  name,
  value,
  label,
  checked,
  onPick,
  testId,
}: {
  name: string;
  value: T;
  label: string;
  checked: boolean;
  onPick: (value: T) => void;
  testId: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
        checked ? "border-accent-500 bg-accent-50 text-ink-950" : "border-ink-100 text-ink-700 hover:bg-ink-50",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onPick(value)}
        className="accent-accent-500"
        data-testid={testId}
      />
      {label}
    </label>
  );
}

/**
 * The pack feedback questions (docs/phases/PHASE_18.md P18-05): would you use
 * these files live, what would make them better, would you pay, and the
 * quote consent with an empty name field. Shared by the card on the pack
 * page and the signed link page from the day 2 email.
 */
export function PackFeedbackForm({ endpoint, idPrefix, onDone }: PackFeedbackFormProps) {
  const [usable, setUsable] = useState<UsableAnswer | null>(null);
  const [wouldPay, setWouldPay] = useState<WouldPayAnswer | null>(null);
  const [comment, setComment] = useState("");
  const [consent, setConsent] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const body = { usable, wouldPay, comment, quoteConsent: consent, displayName: consent ? name : null };
    const checked = validateFeedbackAnswer(body);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(checked.answer),
      });
      const data = (await response.json().catch(() => ({}))) as {
        feedback?: FeedbackStatus;
        notice?: string;
        error?: string;
      };
      if (!response.ok) {
        setError(data.error ?? FEEDBACK_COPY.failed);
        return;
      }
      track("pack_feedback_sent", { usable: checked.answer.usable, quote: checked.answer.quoteConsent });
      onDone(data.feedback ?? null, checked.answer.usable === "not_yet" ? FEEDBACK_COPY.notYetThanks : (data.notice ?? FEEDBACK_COPY.thanks));
    } catch {
      setError(FEEDBACK_COPY.offline);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-5"
      data-testid="feedback-form"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <fieldset>
        <legend className="text-sm font-semibold text-ink-900">{FEEDBACK_COPY.title}</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {USABLE_ANSWERS.map((value) => (
            <Choice
              key={value}
              name={`${idPrefix}-usable`}
              value={value}
              label={FEEDBACK_COPY.usable[value]}
              checked={usable === value}
              onPick={setUsable}
              testId={`feedback-usable-${value}`}
            />
          ))}
        </div>
      </fieldset>

      <label className="block text-sm">
        <span className="font-semibold text-ink-900">{FEEDBACK_COPY.betterLabel}</span>
        <span className="mt-0.5 block text-xs text-ink-500">{FEEDBACK_COPY.betterHint}</span>
        <Textarea
          className="mt-2 min-h-20"
          value={comment}
          maxLength={packFeedback.commentMaxChars}
          onChange={(event) => setComment(event.target.value)}
          data-testid="feedback-comment"
        />
      </label>

      <fieldset>
        <legend className="text-sm font-semibold text-ink-900">{FEEDBACK_COPY.wouldPayLabel}</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {WOULD_PAY_ANSWERS.map((value) => (
            <Choice
              key={value}
              name={`${idPrefix}-pay`}
              value={value}
              label={FEEDBACK_COPY.wouldPay[value]}
              checked={wouldPay === value}
              onPick={setWouldPay}
              testId={`feedback-pay-${value}`}
            />
          ))}
        </div>
      </fieldset>

      <div className="space-y-2">
        <label className="flex cursor-pointer items-start gap-3 text-sm text-ink-700">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
            className="mt-0.5 h-4 w-4 accent-accent-500"
            data-testid="feedback-consent"
          />
          <span>
            <span className="block">{FEEDBACK_COPY.consentLabel}</span>
            <span className="block text-xs text-ink-500">{FEEDBACK_COPY.consentHint}</span>
          </span>
        </label>
        {consent ? (
          <Input
            value={name}
            maxLength={packFeedback.displayNameMaxChars}
            placeholder={FEEDBACK_COPY.namePlaceholder}
            aria-label={FEEDBACK_COPY.namePlaceholder}
            onChange={(event) => setName(event.target.value)}
            data-testid="feedback-name"
          />
        ) : null}
      </div>

      {error ? (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={busy || usable === null} data-testid="feedback-send">
        {busy ? FEEDBACK_COPY.sending : FEEDBACK_COPY.send}
      </Button>
    </form>
  );
}
