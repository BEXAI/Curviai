/**
 * Cookie consent for analytics. PostHog is the only non essential script the
 * app loads, and it now loads only after the visitor says yes: the choice
 * lives in a first party cookie (curvi_consent, granted or denied, 180 days),
 * the Analytics component reads it before initializing, and the banner and
 * the footer's "Cookie settings" link write it. Sign in and session cookies
 * are essential and not covered by this choice.
 *
 * Everything here is safe to import on the server; the browser only helpers
 * do nothing without a document.
 */

export const CONSENT_COOKIE = "curvi_consent";
export const CONSENT_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
/** Fired on window after the choice changes; detail is the new choice. */
export const CONSENT_CHANGED_EVENT = "curvi:consent-changed";
/** Fired on window to show the banner again (footer "Cookie settings"). */
export const CONSENT_OPEN_EVENT = "curvi:consent-open";

export type ConsentChoice = "granted" | "denied";

/** True when analytics is configured at all; without it there is nothing to consent to. */
export function analyticsConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY);
}

/** The stored choice in a Cookie header or document.cookie string. */
export function parseConsent(cookieString: string | null | undefined): ConsentChoice | null {
  for (const part of (cookieString ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === CONSENT_COOKIE) {
      const value = rest.join("=");
      return value === "granted" || value === "denied" ? value : null;
    }
  }
  return null;
}

/** The Set-Cookie style string that stores a choice. */
export function consentCookieString(choice: ConsentChoice, secure: boolean): string {
  return [
    `${CONSENT_COOKIE}=${choice}`,
    "Path=/",
    `Max-Age=${CONSENT_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** The visitor's stored choice, or null before they chose (or on the server). */
export function readConsent(): ConsentChoice | null {
  if (typeof document === "undefined") {
    return null;
  }
  return parseConsent(document.cookie);
}

/** Stores the choice and tells the Analytics component. */
export function writeConsent(choice: ConsentChoice): void {
  if (typeof document === "undefined") {
    return;
  }
  document.cookie = consentCookieString(choice, window.location.protocol === "https:");
  window.dispatchEvent(new CustomEvent<ConsentChoice>(CONSENT_CHANGED_EVENT, { detail: choice }));
}

/** Shows the consent banner again so the visitor can change their choice. */
export function openConsentSettings(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CONSENT_OPEN_EVENT));
  }
}

/** Plain copy for the banner (CLAUDE.md rule 9). */
export const CONSENT_COPY = {
  message:
    "We would like to use analytics cookies to learn which pages help sellers. They stay off unless you accept. You can change this later from Cookie settings in the site footer.",
  accept: "Accept analytics",
  decline: "Decline",
  privacyLink: "Privacy policy",
  settings: "Cookie settings",
} as const;
