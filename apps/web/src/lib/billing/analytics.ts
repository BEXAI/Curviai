/**
 * Client side billing funnel events for PostHog, sent through lib/track.ts:
 * a no op unless NEXT_PUBLIC_POSTHOG_KEY is set and the visitor accepted
 * analytics cookies. Never throws, so analytics never breaks a billing
 * action.
 */

import { captureEvent } from "@/lib/track";

export type BillingEventName =
  | "pricing_cta_clicked"
  | "checkout_started"
  | "checkout_returned"
  | "upgrade_requested"
  | "portal_opened";

export function trackBillingEvent(name: BillingEventName, props: Record<string, unknown> = {}): void {
  captureEvent(name, props);
}
