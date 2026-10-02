"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useState } from "react";
import { Button, Input } from "@curvi/ui";
import { track } from "@/lib/track";
import { LEAD_HONEYPOT_FIELD, type LeadSource } from "@/lib/lead-sources";
import { MarketingConsentCheckbox } from "./marketing-consent";

/** Remembered per browser, so a visitor who already left an email is not asked again. */
const UNLOCK_STORAGE_KEY = "curvi.tools.unlocked";

function readUnlocked(): boolean {
  try {
    return window.localStorage.getItem(UNLOCK_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberUnlocked(): void {
  try {
    window.localStorage.setItem(UNLOCK_STORAGE_KEY, "1");
  } catch {
    // Private windows can refuse storage; the gate simply asks again next time.
  }
}

/**
 * Shows the free summary above and the full results only once the visitor
 * leaves an email (POST /api/leads). The children render only after unlock,
 * so nothing gated reaches the page before then.
 */
export function EmailGate({
  source,
  title,
  body,
  children,
}: {
  source: LeadSource;
  /** Heading of the gate, e.g. "See the full report". */
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  const id = useId();
  const [unlocked, setUnlocked] = useState(false);
  const [email, setEmail] = useState("");
  const [honeypot, setHoneypot] = useState("");
  // P18-06: unticked by default; only a tick is marketing consent.
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (readUnlocked()) {
      setUnlocked(true);
    }
  }, []);

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const response = await fetch("/api/leads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, source, marketingConsent: consent, [LEAD_HONEYPOT_FIELD]: honeypot }),
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          setError(payload?.error ?? "We could not save that just now. Try again in a minute.");
          return;
        }
        rememberUnlocked();
        setUnlocked(true);
        track("lead_captured", { source });
      } catch {
        setError("We could not reach Curvi. Check your connection and try again.");
      } finally {
        setBusy(false);
      }
    },
    [consent, email, honeypot, source],
  );

  if (unlocked) {
    return <div data-testid="email-gate-unlocked">{children}</div>;
  }

  return (
    <div data-testid="email-gate" className="rounded-xl border border-accent-200 bg-accent-50 p-5">
      <h3 className="text-base font-semibold text-ink-950">{title}</h3>
      <p className="mt-1 text-sm text-ink-600">{body}</p>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-2 sm:flex-row" noValidate>
        <label className="sr-only" htmlFor={`${id}-email`}>
          Email
        </label>
        <Input
          id={`${id}-email`}
          type="email"
          name="email"
          required
          autoComplete="email"
          placeholder="you@yourbrand.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="flex-1 bg-white"
        />
        {/* Honeypot: hidden from people and screen readers, filled only by bots. */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label htmlFor={`${id}-${LEAD_HONEYPOT_FIELD}`}>Leave this empty</label>
          <input
            id={`${id}-${LEAD_HONEYPOT_FIELD}`}
            type="text"
            name={LEAD_HONEYPOT_FIELD}
            tabIndex={-1}
            autoComplete="off"
            value={honeypot}
            onChange={(event) => setHoneypot(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={busy || email.trim().length === 0}>
          {busy ? "Unlocking" : "Show full results"}
        </Button>
      </form>
      <MarketingConsentCheckbox id={`${id}-consent`} checked={consent} onChange={setConsent} />
      {error ? (
        <p className="mt-2 text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-ink-500">
        We keep your email to follow up about Curvi, and never sell it. Ask us to delete it any time. See the{" "}
        <Link href="/privacy" className="underline">
          privacy policy
        </Link>
        .
      </p>
    </div>
  );
}
