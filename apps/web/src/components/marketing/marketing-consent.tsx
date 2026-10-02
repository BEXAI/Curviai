"use client";

import { MARKETING_CONSENT_LABEL } from "@/lib/email/copy";

/**
 * The unticked marketing consent box beside an email field
 * (docs/phases/PHASE_18.md P18-06, founder decision 5). Ticking it is the
 * only way a lead gets tips or offers; the results the visitor asked for
 * never depend on it.
 */
export function MarketingConsentCheckbox({
  id,
  checked,
  onChange,
  tone = "light",
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  tone?: "light" | "dark";
}) {
  return (
    <label htmlFor={id} className={`mt-3 flex cursor-pointer items-start gap-2 text-sm ${tone === "dark" ? "text-ink-200" : "text-ink-700"}`}>
      <input
        id={id}
        type="checkbox"
        name="marketingConsent"
        data-testid="marketing-consent"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 accent-accent-500"
      />
      <span>{MARKETING_CONSENT_LABEL}</span>
    </label>
  );
}
