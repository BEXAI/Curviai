import type { PostHog } from "posthog-js";

/** Consent permits pageviews and explicitly emitted product events. It never
 * permits DOM autocapture or session replay, which may contain case text and
 * one-time credentials. Keep these local restrictions on an existing instance
 * too, before restoring capture after a consent change. */
export function initializeAnalytics(posthog: PostHog, key: string, host: string): void {
  const privacy = { autocapture: false, disable_session_recording: true } as const;
  if (!posthog.__loaded) {
    posthog.init(key, {
      api_host: host,
      capture_pageview: "history_change",
      capture_pageleave: true,
      ...privacy,
    });
    return;
  }
  posthog.set_config(privacy);
  if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing({ captureEventName: false });
}
