import { describe, expect, it } from "vitest";
import {
  FIRST_TOUCH_COOKIE,
  FIRST_TOUCH_MAX_BYTES,
  buildFirstTouch,
  cleanFirstTouch,
  cleanSignupAttributionHint,
  clearFirstTouchCookieString,
  decodeAttributionParam,
  encodeAttributionParam,
  firstTouchCookieString,
  parseFirstTouch,
  signupAttributionHint,
} from "./attribution";
import { signupHref } from "./billing/intent";

// Lane 1 (docs/phases/PHASE_18.md P18-01): the first touch cookie, the
// signup hint the form sends, and how the server cleans it again.

const NOW = new Date("2026-10-05T12:00:00.000Z");

describe("buildFirstTouch", () => {
  it("keeps the landing params, the referring host and the path, never this site", () => {
    expect(
      buildFirstTouch({
        href: "https://curvi.ai/for/candles?utm_source=Reddit&utm_campaign=label_test&email=a%40b.co",
        referrer: "https://www.reddit.com/r/etsysellers/comments/abc",
        ownHosts: ["curvi.ai"],
        now: NOW,
      }),
    ).toEqual({
      utm_source: "reddit",
      utm_campaign: "label_test",
      referrer_host: "reddit.com",
      landing_path: "/for/candles",
      first_seen_at: NOW.toISOString(),
    });
    const own = buildFirstTouch({ href: "https://curvi.ai/", referrer: "https://curvi.ai/pricing", ownHosts: ["curvi.ai"], now: NOW });
    expect(own).toEqual({ landing_path: "/", first_seen_at: NOW.toISOString() });
  });

  it("hides ids in the landing path, as the visitor count does", () => {
    const touch = buildFirstTouch({ href: "https://curvi.ai/s/k7mxq2rtva?s=k7mxq2rtva", referrer: "", ownHosts: [], now: NOW });
    expect(touch.landing_path).toBe("/s/:id");
    expect(touch.s).toBe("k7mxq2rtva");
  });
});

describe("the first touch cookie", () => {
  it("round trips through the cookie string and stays under 1 KB", () => {
    const touch = buildFirstTouch({
      href: "https://curvi.ai/?utm_source=newsletter&ref=ab12cd34",
      referrer: "https://news.example.org/post",
      ownHosts: ["curvi.ai"],
      now: NOW,
    });
    const cookie = firstTouchCookieString(touch, true);
    expect(cookie).not.toBeNull();
    expect(cookie).toContain(`${FIRST_TOUCH_COOKIE}=`);
    expect(cookie).toContain(`Max-Age=${90 * 24 * 60 * 60}`);
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    const pair = (cookie as string).split(";")[0];
    expect(pair.length).toBeLessThanOrEqual(FIRST_TOUCH_MAX_BYTES);
    expect(parseFirstTouch(`curvi_consent=granted; ${pair}`, NOW)).toEqual(touch);
  });

  it("stores nothing that would pass 1 KB", () => {
    const fits = { first_seen_at: NOW.toISOString(), utm_content: "x".repeat(100), landing_path: `/${"a".repeat(199)}` };
    expect(firstTouchCookieString(fits, false)).not.toBeNull();
    const huge = { ...fits, utm_term: "é".repeat(100), utm_campaign: "ü".repeat(100) };
    expect(firstTouchCookieString(huge, false)).toBeNull();
  });

  it("deletes itself and ignores a broken or stale value", () => {
    expect(clearFirstTouchCookieString(false)).toBe(`${FIRST_TOUCH_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`);
    expect(parseFirstTouch(`${FIRST_TOUCH_COOKIE}=%7Bnot-json`, NOW)).toBeNull();
    expect(parseFirstTouch("curvi_consent=granted", NOW)).toBeNull();
    const stale = encodeURIComponent(JSON.stringify({ first_seen_at: "2026-01-01T00:00:00.000Z", utm_source: "old" }));
    expect(parseFirstTouch(`${FIRST_TOUCH_COOKIE}=${stale}`, NOW)).toBeNull();
    expect(cleanFirstTouch({ first_seen_at: "2027-01-01T00:00:00.000Z" }, NOW)).toBeNull();
  });
});

describe("signupAttributionHint", () => {
  const touch = {
    utm_source: "reddit",
    utm_campaign: "label_test",
    referrer_host: "reddit.com",
    landing_path: "/",
    first_seen_at: "2026-10-03T09:00:00.000Z",
  };

  it("takes the link from the signup page and the campaign from the first touch", () => {
    expect(
      signupAttributionHint({
        page: { source: "header", utm_source: "newsletter", utm_medium: "email" },
        firstTouch: touch,
        selfReported: "reddit",
        consent: "granted",
      }),
    ).toEqual({
      source: "header",
      utm_source: "reddit",
      utm_campaign: "label_test",
      referrer_host: "reddit.com",
      landing_path: "/",
      first_seen_at: "2026-10-03T09:00:00.000Z",
      self_reported: "reddit",
      consent: "granted",
    });
  });

  it("uses the signup page's UTM tags without a first touch, and keeps Other text only for Other", () => {
    expect(
      signupAttributionHint({
        page: { source: "share", s: "k7mxq2rtva", utm_source: "x" },
        firstTouch: null,
        selfReported: "other",
        selfReportedOther: "  A podcast \n about selling  ",
        consent: null,
      }),
    ).toEqual({
      source: "share",
      s: "k7mxq2rtva",
      utm_source: "x",
      self_reported: "other",
      self_reported_other: "A podcast about selling",
      consent: null,
    });
    expect(
      signupAttributionHint({ page: {}, firstTouch: null, selfReported: "search", selfReportedOther: "ignored", consent: "denied" }),
    ).toEqual({ self_reported: "search", consent: "denied" });
  });

  it("drops an unknown answer and an email typed as Other", () => {
    expect(
      signupAttributionHint({ page: {}, firstTouch: null, selfReported: "made_up", consent: null }),
    ).toEqual({ consent: null });
    expect(
      signupAttributionHint({ page: {}, firstTouch: null, selfReported: "other", selfReportedOther: "me@example.com", consent: null }),
    ).toEqual({ self_reported: "other", consent: null });
  });
});

describe("cleanSignupAttributionHint (server)", () => {
  it("keeps every allowed key with the browser's rules and drops the rest", () => {
    expect(
      cleanSignupAttributionHint(
        {
          source: "pricing",
          utm_source: "Reddit",
          utm_content: "c".repeat(150),
          ref: "AB12CD34",
          s: "k7mxq2rtva",
          claim: "a1".repeat(12),
          preview: "0F8E2A4C-1B3D-4E5F-8A9B-0C1D2E3F4A5B",
          referrer_host: "www.Google.com",
          landing_path: "/tools/main-image-checker?x=1",
          first_seen_at: "2026-10-04T10:00:00Z",
          self_reported: "friend",
          consent: "granted",
          email: "seller@example.com",
          gclid: "abc",
        },
        NOW,
      ),
    ).toEqual({
      source: "pricing",
      utm_source: "reddit",
      utm_content: "c".repeat(100),
      ref: "ab12cd34",
      s: "k7mxq2rtva",
      claim: "a1".repeat(12),
      preview: "0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
      referrer_host: "google.com",
      landing_path: "/tools/main-image-checker",
      first_seen_at: "2026-10-04T10:00:00.000Z",
      self_reported: "friend",
      consent: "granted",
    });
  });

  it("returns only a null consent for junk", () => {
    expect(cleanSignupAttributionHint("nope", NOW)).toEqual({});
    expect(cleanSignupAttributionHint({ source: "evil_page", referrer_host: "not a host", consent: "yes" }, NOW)).toEqual({
      consent: null,
    });
  });
});

describe("the attr parameter (Google sign in, P18-13)", () => {
  it("round trips a hint through base64url", () => {
    const hint = { source: "home", utm_source: "tiktok", self_reported: "tiktok", consent: "granted" as const };
    const encoded = encodeAttributionParam(hint);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeAttributionParam(encoded)).toEqual(hint);
  });

  it("refuses anything that is not base64url JSON", () => {
    expect(decodeAttributionParam(null)).toBeNull();
    expect(decodeAttributionParam("not base64!")).toBeNull();
    expect(decodeAttributionParam("a".repeat(5000))).toBeNull();
    expect(decodeAttributionParam("bm90IGpzb24")).toBeNull();
  });
});

describe("signupHref keeps its pricing behavior and forwards extras", () => {
  it("builds the pricing link as before and validates extras", () => {
    expect(signupHref({ plan: "growth", cadence: "annual", source: "pricing" })).toBe(
      "/signup?plan=growth&cadence=annual&source=pricing",
    );
    expect(signupHref({ source: "channel", extra: { channel: "amazon" } })).toBe("/signup?source=channel&channel=amazon");
    expect(signupHref({ source: "category", extra: { category: "jewelry", s: "bad slug!" } })).toBe(
      "/signup?source=category&category=jewelry",
    );
  });
});
