"use client";

import { useEffect } from "react";
import { CONSENT_CHANGED_EVENT, readConsent, type ConsentChoice } from "@/lib/consent";
import { initializeAnalytics } from "@/lib/analytics-init";

/**
 * PostHog analytics, active only when NEXT_PUBLIC_POSTHOG_KEY is set and the
 * visitor accepted analytics cookies (lib/consent.ts). The library loads
 * lazily and only after consent, so a visitor who declines, or has not
 * chosen yet, downloads no analytics code and gets no analytics cookies.
 * Withdrawing consent later opts the running instance out, which stops
 * capture and clears its persistence. Pageviews follow client navigations
 * ("history_change"), since the App Router changes pages without a load.
 * DOM autocapture and session replay are disabled, including after reconsent.
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
    let active = true;
    let currentChoice: ConsentChoice | null = null;
    const apply = (choice: ConsentChoice | null): void => {
      currentChoice = choice;
      if (choice === "granted") {
        started = true;
        void import("posthog-js")
          .then(({ default: posthog }) => {
            // A consent change or unmount can arrive while the SDK loads.
            // Never let an older grant initialize a pageview after withdrawal.
            if (!active || currentChoice !== "granted") return;
            initializeAnalytics(posthog, key, process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com");
          })
          .catch(() => undefined);
        return;
      }
      if (choice === "denied" && started) {
        void import("posthog-js")
          .then(({ default: posthog }) => {
            if (active && currentChoice === "denied" && posthog.__loaded) {
              posthog.opt_out_capturing();
            }
          })
          .catch(() => undefined);
      }
    };
    apply(readConsent());
    const onChange = (event: Event): void => apply((event as CustomEvent<ConsentChoice>).detail ?? null);
    window.addEventListener(CONSENT_CHANGED_EVENT, onChange);
    return () => {
      active = false;
      window.removeEventListener(CONSENT_CHANGED_EVENT, onChange);
    };
  }, []);
  return null;
}
