"use client";

import { useState, useTransition } from "react";
import { cn } from "@curvi/ui";
import { setMarketingEmailAction } from "@/app/app/settings/actions";
import { EMAIL_SETTINGS_HELP, EMAIL_SETTINGS_LABEL } from "@/lib/email/copy";

/** The settings toggle for tips and offers (docs/phases/PHASE_18.md P18-06).
 * Saves on change; transactional email is not affected. */
export function EmailPreferencesForm({ initialAllowed }: { initialAllowed: boolean }) {
  const [allowed, setAllowed] = useState(initialAllowed);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function change(next: boolean) {
    const previous = allowed;
    setAllowed(next);
    startTransition(async () => {
      const result = await setMarketingEmailAction(next);
      if (!result.ok) {
        setAllowed(previous);
      }
      setNotice({ ok: result.ok, text: result.notice });
    });
  }

  return (
    <div className="space-y-2">
      <label className="flex cursor-pointer items-start gap-3 text-sm text-ink-900">
        <input
          type="checkbox"
          data-testid="marketing-email-toggle"
          checked={allowed}
          disabled={pending}
          onChange={(event) => change(event.target.checked)}
          className="mt-0.5 h-4 w-4 accent-accent-500"
        />
        <span>
          <span className="block font-medium">{EMAIL_SETTINGS_LABEL}</span>
          <span className="block text-xs text-ink-500">{EMAIL_SETTINGS_HELP}</span>
        </span>
      </label>
      {notice ? (
        <p className={cn("text-sm", notice.ok ? "text-emerald-700" : "text-amber-700")} data-testid="marketing-email-result">
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}
