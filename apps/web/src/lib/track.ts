/**
 * Client side product analytics events. A no op unless PostHog is configured
 * (NEXT_PUBLIC_POSTHOG_KEY), in which case the Analytics component already
 * initialised the shared posthog-js instance. Never throws: analytics must not
 * break a page.
 */

export type TrackProps = Record<string, string | number | boolean | null>;

export function track(event: string, props: TrackProps = {}): void {
  if (typeof window === "undefined" || !process.env.NEXT_PUBLIC_POSTHOG_KEY) {
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
