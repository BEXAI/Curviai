"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, Input, cn } from "@curvi/ui";
import { fetchAcquisitionState, WAITLIST_LEAD_SOURCE, type ClientAcquisitionState } from "@/lib/acquisition-client";
import { LEAD_HONEYPOT_FIELD } from "@/lib/lead-sources";
import { track } from "@/lib/track";
import { MarketingConsentCheckbox } from "./marketing-consent";
import {
  WAITLIST_BUSY,
  WAITLIST_CLOSE,
  WAITLIST_CTA_LABEL,
  WAITLIST_DONE,
  WAITLIST_NOTICE,
  WAITLIST_OFFLINE,
  WAITLIST_PRIVACY,
  WAITLIST_SAVE_FAILED,
  WAITLIST_SUBMIT,
  WAITLIST_TITLE,
  WAITLIST_TOOLS_LINK,
} from "./acquisition-copy";

export { WAITLIST_LEAD_SOURCE } from "@/lib/acquisition-client";

/**
 * The gate as this page sees it: open on the server render and until the
 * one shared GET /api/status answers, so static pages stay static and a
 * slow or failed status call never hides the links.
 */
export function useAcquisitionState(): ClientAcquisitionState {
  const [state, setState] = useState<ClientAcquisitionState>("open");
  useEffect(() => {
    let live = true;
    void fetchAcquisitionState().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/**
 * Wraps a primary Start free call to action (docs/phases/PHASE_18.md
 * P18-03). While packs can run it renders its children unchanged. While the
 * acquisition gate is closed it renders a "Get notified when packs are back"
 * button with the same look, which opens a small dialog that stores the
 * email under the packs-paused lead source (POST /api/leads).
 */
export function AcquisitionCta({ children, className }: { children: ReactNode; className?: string }) {
  const state = useAcquisitionState();
  if (state !== "waitlist") {
    return <>{children}</>;
  }
  return <WaitlistNotify className={className} />;
}

/** The waitlist button and its dialog. */
export function WaitlistNotify({ className }: { className?: string }) {
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [honeypot, setHoneypot] = useState("");
  // P18-06: unticked by default; only a tick is marketing consent.
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    }
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [open]);

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const response = await fetch("/api/leads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email,
            source: WAITLIST_LEAD_SOURCE,
            marketingConsent: consent,
            [LEAD_HONEYPOT_FIELD]: honeypot,
          }),
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          setError(payload?.error ?? WAITLIST_SAVE_FAILED);
          return;
        }
        setDone(true);
        track("lead_captured", { source: WAITLIST_LEAD_SOURCE });
      } catch {
        setError(WAITLIST_OFFLINE);
      } finally {
        setBusy(false);
      }
    },
    [consent, email, honeypot],
  );

  const close = () => setOpen(false);

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} data-testid="waitlist-cta">
        {WAITLIST_CTA_LABEL}
      </button>
      {open ? (
        <dialog
          ref={ref}
          aria-labelledby={`${id}-title`}
          onClose={close}
          onClick={(event) => {
            // A click on the backdrop lands on the dialog element itself.
            if (event.target === event.currentTarget) close();
          }}
          className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-ink-100 bg-white p-0 text-left text-ink-950 shadow-xl backdrop:bg-ink-950/40"
          data-testid="waitlist-dialog"
        >
          <div className="p-6">
            <h2 id={`${id}-title`} className="text-lg font-semibold">
              {WAITLIST_TITLE}
            </h2>
            <p className="mt-2 text-sm text-ink-600">{WAITLIST_NOTICE}</p>
            {done ? (
              <p className="mt-4 text-sm font-medium text-ink-950" role="status" data-testid="waitlist-done">
                {WAITLIST_DONE}
              </p>
            ) : (
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
                  {busy ? WAITLIST_BUSY : WAITLIST_SUBMIT}
                </Button>
              </form>
            )}
            {done ? null : <MarketingConsentCheckbox id={`${id}-consent`} checked={consent} onChange={setConsent} />}
            {error ? (
              <p className="mt-2 text-sm text-red-600" role="alert">
                {error}
              </p>
            ) : null}
            <p className="mt-3 text-xs text-ink-500">
              {WAITLIST_PRIVACY} See the{" "}
              <Link href="/privacy" className="underline">
                privacy policy
              </Link>
              .
            </p>
            <div className={cn("mt-4 flex items-center justify-between gap-3 border-t border-ink-100 pt-4")}>
              <Link href="/tools/main-image-checker" className="text-sm font-medium underline">
                {WAITLIST_TOOLS_LINK}
              </Link>
              <Button variant="ghost" size="sm" onClick={close}>
                {WAITLIST_CLOSE}
              </Button>
            </div>
          </div>
        </dialog>
      ) : null}
    </>
  );
}
