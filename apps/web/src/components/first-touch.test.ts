import { describe, expect, it } from "vitest";
import { firstTouchCookieUpdate, type LandingPage } from "./first-touch";

// Founder decision 2 (P18-01): the first touch cookie is written only after
// the visitor accepts cookies, never overwritten, and deleted on decline.

const NOW = new Date("2026-10-05T12:00:00.000Z");
const LANDING: LandingPage = {
  href: "https://curvi.ai/for/jewelry?utm_source=reddit",
  referrer: "https://www.reddit.com/r/etsy",
  path: "/for/jewelry",
};
const base = { landing: LANDING, cookieString: "", host: "curvi.ai", secure: true, now: NOW };

describe("firstTouchCookieUpdate", () => {
  it("writes nothing before a choice or after a decline", () => {
    expect(firstTouchCookieUpdate(null, base)).toBeNull();
    expect(firstTouchCookieUpdate("denied", base)).toBeNull();
  });

  it("writes the landing page once consent is granted", () => {
    const cookie = firstTouchCookieUpdate("granted", base);
    expect(cookie).toMatch(/^curvi_ft=/);
    const value = JSON.parse(decodeURIComponent((cookie ?? "").split(";")[0].slice("curvi_ft=".length)));
    expect(value).toEqual({
      utm_source: "reddit",
      referrer_host: "reddit.com",
      landing_path: "/for/jewelry",
      first_seen_at: NOW.toISOString(),
    });
  });

  it("never overwrites an existing first touch, and deletes it on decline", () => {
    const withCookie = { ...base, cookieString: "curvi_consent=granted; curvi_ft=%7B%7D" };
    expect(firstTouchCookieUpdate("granted", withCookie)).toBeNull();
    expect(firstTouchCookieUpdate("denied", withCookie)).toBe("curvi_ft=; Path=/; Max-Age=0; SameSite=Lax; Secure");
  });

  it("does not treat an app page as a first touch", () => {
    expect(firstTouchCookieUpdate("granted", { ...base, landing: { ...LANDING, path: "/app/new" } })).toBeNull();
    expect(firstTouchCookieUpdate("granted", { ...base, landing: null })).toBeNull();
  });
});
