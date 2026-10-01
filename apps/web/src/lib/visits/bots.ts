/**
 * Requests the visitor count ignores: no user agent at all, a known bot or
 * crawler (the isbot package's maintained pattern list, which also matches
 * headless browsers), and prefetches or prerenders that no person has looked
 * at yet. The beacon itself waits for a prerendered page to be shown and
 * skips browsers driven by automation (navigator.webdriver), so this is the
 * server side half of the same filter.
 */

import { isbot } from "isbot";

export type VisitSkipReason = "no_user_agent" | "prefetch" | "bot";

// Purpose and Sec-Purpose: prefetch (and prefetch;prerender) from Chromium
// speculation rules and link prefetch; X-Purpose: preview from Safari's top
// sites; X-Moz: prefetch from Firefox.
const PREFETCH_HEADERS = ["purpose", "sec-purpose", "x-purpose", "x-moz"] as const;
const PREFETCH_VALUE = /prefetch|prerender|preview/i;

export function isPrefetch(headers: Headers): boolean {
  return PREFETCH_HEADERS.some((name) => PREFETCH_VALUE.test(headers.get(name) ?? ""));
}

/** Why this request is not a person's page view, or null when it counts. */
export function visitSkipReason(headers: Headers): VisitSkipReason | null {
  const userAgent = headers.get("user-agent")?.trim() ?? "";
  if (!userAgent) {
    return "no_user_agent";
  }
  if (isPrefetch(headers)) {
    return "prefetch";
  }
  if (isbot(userAgent)) {
    return "bot";
  }
  return null;
}
