"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { buttonVariants } from "@curvi/ui";
import {
  analyticsConfigured,
  CONSENT_COPY,
  CONSENT_OPEN_EVENT,
  openConsentSettings,
  readConsent,
  writeConsent,
} from "@/lib/consent";

/** Both choices share one class, so declining is exactly as easy and as
 * visible as accepting. */
export const CONSENT_BUTTON_CLASS = buttonVariants({ variant: "outline", size: "md", className: "min-w-32" });

export function CookieConsentView({ onAccept, onDecline }: { onAccept: () => void; onDecline: () => void }) {
  return (
    <div
      role="region"
      aria-label="Cookie choice"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-ink-950/10 bg-white/95 px-4 py-4 shadow-lg backdrop-blur sm:px-6"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-ink-700">
          {CONSENT_COPY.message}{" "}
          <Link href="/privacy" className="font-medium text-ink-900 underline">
            {CONSENT_COPY.privacyLink}
          </Link>
        </p>
        <div className="flex shrink-0 gap-3">
          <button type="button" className={CONSENT_BUTTON_CLASS} onClick={onDecline} data-consent="decline">
            {CONSENT_COPY.decline}
          </button>
          <button type="button" className={CONSENT_BUTTON_CLASS} onClick={onAccept} data-consent="accept">
            {CONSENT_COPY.accept}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The analytics cookie banner. Shown once to visitors who have not chosen,
 * and again whenever the footer's Cookie settings link asks for it. Renders
 * nothing when analytics is not configured, since there is nothing to
 * consent to.
 */
export function CookieConsent() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!analyticsConfigured()) {
      return;
    }
    setOpen(readConsent() === null);
    const reopen = (): void => setOpen(true);
    window.addEventListener(CONSENT_OPEN_EVENT, reopen);
    return () => window.removeEventListener(CONSENT_OPEN_EVENT, reopen);
  }, []);

  if (!open) {
    return null;
  }
  return (
    <CookieConsentView
      onAccept={() => {
        writeConsent("granted");
        setOpen(false);
      }}
      onDecline={() => {
        writeConsent("denied");
        setOpen(false);
      }}
    />
  );
}

/** Footer link that reopens the banner; absent when analytics is off. */
export function CookieSettingsLink({ className }: { className?: string }) {
  if (!analyticsConfigured()) {
    return null;
  }
  return (
    <button type="button" className={className} onClick={openConsentSettings}>
      {CONSENT_COPY.settings}
    </button>
  );
}
