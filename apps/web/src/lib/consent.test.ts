import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CONSENT_CHANGED_EVENT,
  CONSENT_COOKIE,
  CONSENT_COPY,
  CONSENT_MAX_AGE_SECONDS,
  consentCookieString,
  parseConsent,
  readConsent,
  writeConsent,
} from "./consent";
import { CONSENT_BUTTON_CLASS, CookieConsentView, CookieSettingsLink } from "@/components/cookie-consent";

// Vitest compiles JSX to React.createElement; set the global before rendering.
beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("consent cookie", () => {
  it("reads the stored choice and ignores anything else", () => {
    expect(parseConsent(`a=1; ${CONSENT_COOKIE}=granted; b=2`)).toBe("granted");
    expect(parseConsent(`${CONSENT_COOKIE}=denied`)).toBe("denied");
    expect(parseConsent(`${CONSENT_COOKIE}=maybe`)).toBeNull();
    expect(parseConsent("other=granted")).toBeNull();
    expect(parseConsent("")).toBeNull();
    expect(parseConsent(null)).toBeNull();
  });

  it("stores the choice first party for 180 days, Secure on https", () => {
    expect(consentCookieString("denied", true)).toBe(
      `${CONSENT_COOKIE}=denied; Path=/; Max-Age=${CONSENT_MAX_AGE_SECONDS}; SameSite=Lax; Secure`,
    );
    expect(consentCookieString("granted", false)).not.toContain("Secure");
    expect(CONSENT_MAX_AGE_SECONDS).toBe(180 * 86400);
  });

  it("writes the cookie and announces the change in the browser", () => {
    const jar = { cookie: "" };
    const events: Array<{ type: string; detail: unknown }> = [];
    vi.stubGlobal("document", jar);
    vi.stubGlobal("window", {
      location: { protocol: "https:" },
      dispatchEvent: (event: CustomEvent) => {
        events.push({ type: event.type, detail: event.detail });
        return true;
      },
    });
    expect(readConsent()).toBeNull();
    writeConsent("denied");
    expect(jar.cookie).toContain(`${CONSENT_COOKIE}=denied`);
    expect(jar.cookie).toContain("Secure");
    expect(events).toEqual([{ type: CONSENT_CHANGED_EVENT, detail: "denied" }]);
    expect(readConsent()).toBe("denied");
  });

  it("does nothing on the server", () => {
    expect(readConsent()).toBeNull();
    expect(() => writeConsent("granted")).not.toThrow();
  });
});

describe("cookie banner", () => {
  it("offers decline and accept as equal one click buttons", () => {
    const html = renderToStaticMarkup(React.createElement(CookieConsentView, { onAccept: () => {}, onDecline: () => {} }));
    const buttons = [...html.matchAll(/<button type="button" class="([^"]+)" data-consent="(accept|decline)">([^<]+)<\/button>/g)];
    expect(buttons.map((m) => m[2]).sort()).toEqual(["accept", "decline"]);
    for (const match of buttons) {
      expect(match[1]).toBe(CONSENT_BUTTON_CLASS);
    }
    expect(html).toContain(CONSENT_COPY.decline);
    expect(html).toContain(CONSENT_COPY.accept);
    expect(html).toContain('href="/privacy"');
  });

  it("keeps the copy plain: no emojis, arrows or dashes as punctuation", () => {
    for (const text of Object.values(CONSENT_COPY)) {
      expect(text).not.toMatch(/[←-⇿‒-―]|->|\s-\s|\p{Extended_Pictographic}/u);
    }
  });

  it("shows the footer settings link only when analytics is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
    expect(renderToStaticMarkup(React.createElement(CookieSettingsLink, {}))).toBe("");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    expect(renderToStaticMarkup(React.createElement(CookieSettingsLink, {}))).toContain(CONSENT_COPY.settings);
  });
});
