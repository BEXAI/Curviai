"use client";

import { Input, Label, Select } from "@curvi/ui";
import { signupSourceChoices } from "@curvi/pipeline/seed";
import { MAX_SELF_REPORTED_OTHER_LENGTH } from "@/lib/attribution";

/** The seller's answer to "How did you hear about Curvi?": a seeded key and
 * the short text for Other. */
export interface SignupSourceAnswer {
  choice: string;
  other: string;
}

export const EMPTY_SIGNUP_SOURCE_ANSWER: SignupSourceAnswer = { choice: "", other: "" };

/** Plain copy for the field (CLAUDE.md rule 9). */
export const SIGNUP_SOURCE_COPY = {
  label: "How did you hear about Curvi?",
  helper: "Optional. It helps a one person company know what works.",
  placeholder: "Choose one",
  otherLabel: "Where did you hear about it?",
} as const;

/**
 * The optional self reported source on the signup form
 * (docs/phases/PHASE_18.md P18-01). Choices come from the seed; "Other"
 * opens a short text field. Leaving it empty never blocks a signup.
 */
export function SignupSourceField({
  value,
  onChange,
}: {
  value: SignupSourceAnswer;
  onChange: (next: SignupSourceAnswer) => void;
}) {
  return (
    <div className="space-y-1.5" data-testid="signup-source">
      <Label htmlFor="signup-source">{SIGNUP_SOURCE_COPY.label}</Label>
      <Select
        id="signup-source"
        name="signup_source_answer"
        value={value.choice}
        onChange={(event) => onChange({ choice: event.target.value, other: value.other })}
        aria-describedby="signup-source-helper"
      >
        <option value="">{SIGNUP_SOURCE_COPY.placeholder}</option>
        {signupSourceChoices.map((choice) => (
          <option key={choice.key} value={choice.key}>
            {choice.label}
          </option>
        ))}
      </Select>
      {value.choice === "other" ? (
        <div className="space-y-1.5 pt-1">
          <Label htmlFor="signup-source-other" className="sr-only">
            {SIGNUP_SOURCE_COPY.otherLabel}
          </Label>
          <Input
            id="signup-source-other"
            name="signup_source_other"
            maxLength={MAX_SELF_REPORTED_OTHER_LENGTH}
            autoComplete="off"
            value={value.other}
            onChange={(event) => onChange({ choice: value.choice, other: event.target.value })}
            placeholder={SIGNUP_SOURCE_COPY.otherLabel}
          />
        </div>
      ) : null}
      <p id="signup-source-helper" className="text-xs text-ink-500">
        {SIGNUP_SOURCE_COPY.helper}
      </p>
    </div>
  );
}
