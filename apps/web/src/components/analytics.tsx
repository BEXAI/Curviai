"use client";

import { useEffect } from "react";

/**
 * PostHog analytics, active only when NEXT_PUBLIC_POSTHOG_KEY is set. The
 * library loads lazily so unconfigured deployments ship zero analytics code
 * to the client.
 */
export function Analytics() {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) {
      return;
    }
    void import("posthog-js").then(({ default: posthog }) => {
      posthog.init(key, {
        api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
        capture_pageview: true,
        capture_pageleave: true,
      });
    });
  }, []);
  return null;
}
