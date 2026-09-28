/**
 * Client side billing funnel events for PostHog. A no op unless
 * NEXT_PUBLIC_POSTHOG_KEY is set; the library is loaded lazily, the same way
 * components/analytics.tsx initializes it.
 */

export type BillingEventName =
  | "pricing_cta_clicked"
  | "checkout_started"
  | "checkout_returned"
  | "upgrade_requested"
  | "portal_opened";

export function trackBillingEvent(name: BillingEventName, props: Record<string, unknown> = {}): void {
  if (typeof window === "undefined" || !process.env.NEXT_PUBLIC_POSTHOG_KEY) {
    return;
  }
  void import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.capture(name, props);
    })
    .catch(() => {
      // Analytics must never break a billing action.
    });
}
