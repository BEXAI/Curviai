import { describe, expect, it } from "vitest";
import { googleOAuthCredentials, googleSignInEnabled, GOOGLE_SIGN_IN_LABEL } from "./google-sign-in";
import {
  ATTR_PARAM,
  MAX_ATTR_PARAM_LENGTH,
  cleanAttributionHint,
  decodeAttributionParam,
  encodeAttributionParam,
  readSignupCallback,
  signupCallbackUrl,
  signupMethodOf,
} from "./signup-callback";

// P18-13: the attribution hint rides the /auth/callback URL as attr (the
// only carrier a Google signup has), and every value is cleaned again when
// it is read, so a crafted callback URL can never store anything else.

const PREVIEW = "0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d";

describe("attribution hint cleaning", () => {
  it("keeps the landing params, first touch fields, answer and consent, and nothing else", () => {
    expect(
      cleanAttributionHint({
        utm_source: "Reddit",
        utm_campaign: "label_test",
        source: "home",
        preview: PREVIEW,
        ref: "abcd1234",
        referrer_host: "News.YCombinator.com",
        landing_path: "/for/beauty?utm_source=x#top",
        first_seen_at: "2026-10-01T09:30:00Z",
        self_reported: "Reddit",
        self_reported_other: "  my   cousin\n told me ",
        consent: "granted",
        email: "seller@example.com",
        password: "hunter22",
      }),
    ).toEqual({
      utm_source: "reddit",
      utm_campaign: "label_test",
      source: "home",
      preview: PREVIEW,
      ref: "abcd1234",
      referrer_host: "news.ycombinator.com",
      landing_path: "/for/beauty",
      first_seen_at: "2026-10-01T09:30:00.000Z",
      self_reported: "reddit",
      self_reported_other: "my cousin told me",
      consent: "granted",
    });
  });

  it("drops values that do not fit", () => {
    expect(
      cleanAttributionHint({
        utm_source: "someone@example.com",
        source: "not-a-seeded-key",
        preview: "not-a-uuid",
        referrer_host: "localhost",
        landing_path: "//evil.example/path",
        first_seen_at: "yesterday",
        self_reported: "Has spaces in it",
        self_reported_other: "write to me at me@example.com",
        consent: "maybe",
      }),
    ).toBeNull();
    expect(cleanAttributionHint(null)).toBeNull();
    expect(cleanAttributionHint(["utm_source"])).toBeNull();
    expect(cleanAttributionHint("utm_source=reddit")).toBeNull();
    expect(cleanAttributionHint({ landing_path: "/a b" })).toBeNull();
    expect(cleanAttributionHint({ landing_path: `/${"a".repeat(250)}` })).toBeNull();
  });
});

describe("attr parameter", () => {
  it("round trips a cleaned hint through base64url", () => {
    const encoded = encodeAttributionParam({ utm_source: "tiktok", self_reported_other: "Café owner group", consent: "denied" });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeAttributionParam(encoded)).toEqual({
      utm_source: "tiktok",
      self_reported_other: "Café owner group",
      consent: "denied",
    });
  });

  it("encodes nothing for an empty hint", () => {
    expect(encodeAttributionParam({})).toBeNull();
    expect(encodeAttributionParam(null)).toBeNull();
    expect(encodeAttributionParam({ consent: null })).toBeNull();
  });

  it("reads malformed, oversized or hostile values as no hint, never throwing", () => {
    expect(decodeAttributionParam(null)).toBeNull();
    expect(decodeAttributionParam("")).toBeNull();
    expect(decodeAttributionParam("not base64!")).toBeNull();
    expect(decodeAttributionParam(Buffer.from("{not json").toString("base64url"))).toBeNull();
    expect(decodeAttributionParam(Buffer.from("[1,2]").toString("base64url"))).toBeNull();
    expect(decodeAttributionParam(Buffer.from([0xff, 0xfe, 0xfd]).toString("base64url"))).toBeNull();
    const huge = Buffer.from(JSON.stringify({ utm_source: "x".repeat(4000) })).toString("base64url");
    expect(huge.length).toBeGreaterThan(MAX_ATTR_PARAM_LENGTH);
    expect(decodeAttributionParam(huge)).toBeNull();
    const proto = Buffer.from('{"__proto__":{"admin":true},"utm_source":"x"}').toString("base64url");
    const decoded = decodeAttributionParam(proto);
    expect(decoded).toEqual({ utm_source: "x" });
    expect(({} as { admin?: boolean }).admin).toBeUndefined();
  });
});

describe("callback URL", () => {
  it("carries next and the attribution hint", () => {
    const url = new URL(
      signupCallbackUrl("https://curvi.ai", {
        next: "/app/billing?checkout=growth&cadence=annual",
        attribution: { utm_source: "reddit", preview: PREVIEW, consent: "granted" },
      }),
    );
    expect(url.origin).toBe("https://curvi.ai");
    expect(url.pathname).toBe("/auth/callback");
    expect(url.searchParams.get("next")).toBe("/app/billing?checkout=growth&cadence=annual");
    expect(decodeAttributionParam(url.searchParams.get(ATTR_PARAM))).toEqual({
      utm_source: "reddit",
      preview: PREVIEW,
      consent: "granted",
    });
  });

  it("leaves attr off when there is nothing to carry", () => {
    const url = new URL(signupCallbackUrl("https://curvi.ai", { next: "/app" }));
    expect([...url.searchParams.keys()]).toEqual(["next"]);
  });

  it("marks only the Google redirect with via=google", () => {
    expect(new URL(signupCallbackUrl("https://curvi.ai", { next: "/app", via: "google" })).searchParams.get("via")).toBe("google");
    expect(new URL(signupCallbackUrl("https://curvi.ai", { next: "/app" })).searchParams.has("via")).toBe(false);
  });
});

describe("signup method and callback context", () => {
  it("is google only when Supabase recorded Google as the first provider", () => {
    expect(signupMethodOf({ app_metadata: { provider: "google" } })).toBe("google");
    expect(signupMethodOf({ app_metadata: { provider: "email" } })).toBe("email");
    expect(signupMethodOf({ app_metadata: {} })).toBe("email");
    expect(signupMethodOf(null)).toBe("email");
    // user_metadata is editable by the user, so it never decides the method.
    expect(signupMethodOf({ app_metadata: {}, user_metadata: { provider: "google" } })).toBe("email");
  });

  it("reads attr first, then the signup metadata hint", () => {
    const attr = encodeAttributionParam({ utm_source: "youtube" }) ?? "";
    const user = { app_metadata: { provider: "google" }, user_metadata: { attribution: { utm_source: "reddit" } } };
    expect(readSignupCallback(new URLSearchParams({ [ATTR_PARAM]: attr, category: "candles" }), user)).toEqual({
      method: "google",
      attribution: { utm_source: "youtube" },
      profile: { category: "candles" },
    });
    expect(readSignupCallback(new URLSearchParams(), user)).toEqual({
      method: "google",
      attribution: { utm_source: "reddit" },
      profile: {},
    });
    expect(readSignupCallback(new URLSearchParams({ [ATTR_PARAM]: "@@@" }), { app_metadata: {} })).toEqual({
      method: "email",
      attribution: null,
      profile: {},
    });
  });
});

describe("Google sign in flag and call", () => {
  it("shows only when NEXT_PUBLIC_GOOGLE_AUTH is 1", () => {
    const before = process.env.NEXT_PUBLIC_GOOGLE_AUTH;
    try {
      delete process.env.NEXT_PUBLIC_GOOGLE_AUTH;
      expect(googleSignInEnabled()).toBe(false);
      process.env.NEXT_PUBLIC_GOOGLE_AUTH = "true";
      expect(googleSignInEnabled()).toBe(false);
      process.env.NEXT_PUBLIC_GOOGLE_AUTH = "1";
      expect(googleSignInEnabled()).toBe(true);
    } finally {
      if (before === undefined) {
        delete process.env.NEXT_PUBLIC_GOOGLE_AUTH;
      } else {
        process.env.NEXT_PUBLIC_GOOGLE_AUTH = before;
      }
    }
  });

  it("asks Supabase for Google with the callback URL", () => {
    const redirectTo = signupCallbackUrl("https://curvi.ai", { next: "/app", attribution: { utm_source: "reddit" } });
    expect(googleOAuthCredentials(redirectTo)).toEqual({ provider: "google", options: { redirectTo } });
    expect(GOOGLE_SIGN_IN_LABEL).toBe("Continue with Google");
  });
});
