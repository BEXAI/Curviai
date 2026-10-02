/**
 * Client side product analytics events. A no op unless PostHog is configured
 * (NEXT_PUBLIC_POSTHOG_KEY) and the visitor accepted analytics cookies
 * (lib/consent.ts); then the Analytics component already initialised the
 * shared posthog-js instance. Without consent the library is never
 * requested, as components/analytics.tsx promises. Never throws: analytics
 * must not break a page.
 */

import { readConsent } from "@/lib/consent";

export type TrackProps = Record<string, string | number | boolean | null>;

/** Sends one event through the loaded posthog-js instance. Shared by
 * track(), trackAuthError() and trackBillingEvent(). */
export function captureEvent(event: string, props: Record<string, unknown> = {}): void {
  if (typeof window === "undefined" || !process.env.NEXT_PUBLIC_POSTHOG_KEY || readConsent() !== "granted") {
    return;
  }
  void import("posthog-js")
    .then(({ default: posthog }) => {
      if (posthog.__loaded) {
        posthog.capture(event, props);
      }
    })
    .catch(() => undefined);
}

export function track(event: string, props: TrackProps = {}): void {
  captureEvent(event, props);
}
