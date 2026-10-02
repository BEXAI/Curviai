"use client";

import { useEffect } from "react";
import { CONSENT_CHANGED_EVENT, readConsent, type ConsentChoice } from "@/lib/consent";

/**
 * PostHog analytics, active only when NEXT_PUBLIC_POSTHOG_KEY is set and the
 * visitor accepted analytics cookies (lib/consent.ts). The library loads
 * lazily and only after consent, so a visitor who declines, or has not
 * chosen yet, downloads no analytics code and gets no analytics cookies.
 * Withdrawing consent later opts the running instance out, which stops
 * capture and clears its persistence. Pageviews follow client navigations
 * ("history_change"), since the App Router changes pages without a load.
 */
export function Analytics() {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) {
      return;
    }
    // Set once the library was requested in this visit, so a decline before
    // any consent never downloads it just to opt out.
    let started = false;
    const apply = (choice: ConsentChoice | null): void => {
      if (choice === "granted") {
        started = true;
        void import("posthog-js")
          .then(({ default: posthog }) => {
            if (!posthog.__loaded) {
              posthog.init(key, {
                api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
                capture_pageview: "history_change",
                capture_pageleave: true,
              });
            } else if (posthog.has_opted_out_capturing()) {
              posthog.opt_in_capturing({ captureEventName: false });
            }
          })
          .catch(() => undefined);
        return;
      }
      if (choice === "denied" && started) {
        void import("posthog-js")
          .then(({ default: posthog }) => {
            if (posthog.__loaded) {
              posthog.opt_out_capturing();
            }
          })
          .catch(() => undefined);
      }
    };
    apply(readConsent());
    const onChange = (event: Event): void => apply((event as CustomEvent<ConsentChoice>).detail ?? null);
    window.addEventListener(CONSENT_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(CONSENT_CHANGED_EVENT, onChange);
  }, []);
  return null;
}
