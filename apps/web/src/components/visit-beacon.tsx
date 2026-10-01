"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { buildVisitPayload, VISITS_ENDPOINT } from "@/lib/visits/payload";

/**
 * The cookieless visitor count (lib/visits): one small POST to /api/visits
 * per page shown, on the first load and on every client side route change.
 * It sets no cookie and reads or writes no storage on the device, so it
 * needs no consent and runs for every visitor, unlike PostHog. It sends
 * nothing from browsers driven by automation (navigator.webdriver), waits
 * for a prerendered page to be shown, and never throws or holds up a render:
 * the request is sent with sendBeacon (fetch with keepalive as a fallback)
 * and nobody waits for the answer.
 */

// Module state lasts one full page load: the first page view after a load
// is the only one that carries document.referrer, and a path is sent once
// per change (React development mode runs effects twice).
let referrerSent = false;
let lastPath: string | null = null;

function send(body: string): void {
  try {
    if (typeof navigator.sendBeacon === "function" && navigator.sendBeacon(VISITS_ENDPOINT, body)) {
      return;
    }
  } catch {
    // Fall through to fetch.
  }
  try {
    void fetch(VISITS_ENDPOINT, {
      method: "POST",
      body,
      keepalive: true,
      credentials: "omit",
      headers: { "content-type": "text/plain;charset=UTF-8" },
    }).catch(() => undefined);
  } catch {
    // The count is best effort; the page never hears about a failure.
  }
}

export function VisitBeacon() {
  const pathname = usePathname();
  useEffect(() => {
    try {
      if (navigator.webdriver) {
        return;
      }
      const path = window.location.pathname;
      if (path === lastPath) {
        return;
      }
      lastPath = path;
      const payload = buildVisitPayload(window.location, referrerSent ? null : document.referrer);
      referrerSent = true;
      const body = JSON.stringify(payload);
      const doc = document as Document & { prerendering?: boolean };
      if (doc.prerendering) {
        document.addEventListener("prerenderingchange", () => send(body), { once: true });
        return;
      }
      send(body);
    } catch {
      // Never let the count break a page.
    }
  }, [pathname]);
  return null;
}
