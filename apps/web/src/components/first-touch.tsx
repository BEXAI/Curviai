"use client";

import { useEffect } from "react";
import {
  FIRST_TOUCH_COOKIE,
  buildFirstTouch,
  clearFirstTouchCookieString,
  firstTouchCookieString,
} from "@/lib/attribution";
import { CONSENT_CHANGED_EVENT, readConsent, type ConsentChoice } from "@/lib/consent";

/**
 * The curvi_ft first touch cookie (docs/phases/PHASE_18.md P18-01, founder
 * decision 2). Before the visitor accepts cookies nothing is stored: the
 * first page of this visit (its address and referrer) is only remembered in
 * memory, so a visitor who accepts on a later page still gets the page that
 * brought them. Once they accept, the cookie is written once and never
 * overwritten; declining later deletes it. In app pages are not a first
 * touch, and nothing here ever throws.
 */

export interface LandingPage {
  href: string;
  referrer: string;
  path: string;
}

/** The first page of this page load, in memory only. */
let landing: LandingPage | null = null;

function hasFirstTouch(cookieString: string): boolean {
  return cookieString.split(";").some((part) => part.trim().startsWith(`${FIRST_TOUCH_COOKIE}=`));
}

/**
 * What to write to document.cookie for a consent choice, or null for
 * nothing: the first touch once consent is granted and none exists yet,
 * the delete string once consent is denied. Pure, so it is tested without a
 * browser.
 */
export function firstTouchCookieUpdate(
  choice: ConsentChoice | null,
  input: { landing: LandingPage | null; cookieString: string; host: string; secure: boolean; now?: Date },
): string | null {
  const existing = hasFirstTouch(input.cookieString);
  if (choice === "denied") {
    return existing ? clearFirstTouchCookieString(input.secure) : null;
  }
  if (choice !== "granted" || !input.landing || existing) {
    return null;
  }
  const path = input.landing.path;
  if (path === "/app" || path.startsWith("/app/") || path.startsWith("/auth/")) {
    return null;
  }
  return firstTouchCookieString(
    buildFirstTouch({ href: input.landing.href, referrer: input.landing.referrer, ownHosts: [input.host], now: input.now }),
    input.secure,
  );
}

function apply(choice: ConsentChoice | null): void {
  try {
    const update = firstTouchCookieUpdate(choice, {
      landing,
      cookieString: document.cookie,
      host: window.location.host,
      secure: window.location.protocol === "https:",
    });
    if (update) {
      document.cookie = update;
    }
  } catch {
    // Attribution is best effort; the page never hears about a failure.
  }
}

export function FirstTouch() {
  useEffect(() => {
    try {
      if (!landing) {
        landing = { href: window.location.href, referrer: document.referrer, path: window.location.pathname };
      }
    } catch {
      return;
    }
    apply(readConsent());
    const onChange = (event: Event): void => apply((event as CustomEvent<ConsentChoice>).detail ?? null);
    window.addEventListener(CONSENT_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(CONSENT_CHANGED_EVENT, onChange);
  }, []);
  return null;
}
