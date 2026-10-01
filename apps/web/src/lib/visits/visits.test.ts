import { describe, expect, it } from "vitest";
import { isPrefetch, visitSkipReason } from "./bots";
import { daysBefore, newSalt, utcDay, visitorHash } from "./hash";
import { cleanUtm, deviceClass, normalizePath, referrerHost } from "./normalize";
import { buildVisitPayload } from "./payload";

const CHROME_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const ANDROID_PHONE =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

describe("visitorHash", () => {
  const base = { salt: "ab".repeat(32), host: "curvi.ai", ip: "203.0.113.7", userAgent: CHROME_DESKTOP };

  it("is the first 16 bytes of a sha256, as 32 hex characters, and stable for the same input", () => {
    const hash = visitorHash(base);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(visitorHash({ ...base })).toBe(hash);
  });

  it("changes with the salt, the IP, the user agent and the site host", () => {
    const hash = visitorHash(base);
    expect(visitorHash({ ...base, salt: "cd".repeat(32) })).not.toBe(hash);
    expect(visitorHash({ ...base, ip: "203.0.113.8" })).not.toBe(hash);
    expect(visitorHash({ ...base, userAgent: IPHONE })).not.toBe(hash);
    expect(visitorHash({ ...base, host: "staging.curvi.ai" })).not.toBe(hash);
  });

  it("never contains the IP or any part of the user agent", () => {
    const hash = visitorHash(base);
    expect(hash).not.toContain("203");
    expect(hash).not.toContain("Mozilla");
  });

  it("keeps the parts apart, so shifting text between IP and user agent gives another code", () => {
    const a = visitorHash({ ...base, ip: "1.2.3.4", userAgent: "5Mozilla" });
    const b = visitorHash({ ...base, ip: "1.2.3.45", userAgent: "Mozilla" });
    expect(a).not.toBe(b);
  });
});

describe("salt and days", () => {
  it("makes 32 random bytes as 64 hex characters, different each time", () => {
    const a = newSalt();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(newSalt()).not.toBe(a);
  });

  it("uses UTC days", () => {
    expect(utcDay(new Date("2026-10-01T23:59:59.000-05:00"))).toBe("2026-10-02");
    expect(utcDay(new Date("2026-10-01T00:00:00.000Z"))).toBe("2026-10-01");
    expect(daysBefore("2026-10-01", 1)).toBe("2026-09-30");
    expect(daysBefore("2026-03-01", 1)).toBe("2026-02-28");
    expect(daysBefore("2026-10-01", 29)).toBe("2026-09-02");
  });
});

describe("normalizePath", () => {
  it("drops the query string and fragment", () => {
    expect(normalizePath("/pricing?utm_source=x&email=a@b.com#plans")).toBe("/pricing");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/?ref=1")).toBe("/");
  });

  it("replaces UUIDs, long numbers, long hex ids and share slugs with :id", () => {
    expect(normalizePath("/app/jobs/5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d")).toBe("/app/jobs/:id");
    expect(normalizePath("/orders/12345678/items/42")).toBe("/orders/:id/items/42");
    expect(normalizePath("/files/0123456789abcdef0123")).toBe("/files/:id");
    expect(normalizePath("/s/abcd2345xy")).toBe("/s/:id");
    expect(normalizePath("/s/abcd2345xy/image/hero")).toBe("/s/:id/image/hero");
    expect(normalizePath("/channels/amazon/image-requirements")).toBe("/channels/amazon/image-requirements");
  });

  it("removes repeated and trailing slashes and control characters", () => {
    expect(normalizePath("/help/")).toBe("/help");
    expect(normalizePath("/for//candles/")).toBe("/for/candles");
    expect(normalizePath("/he\u0000lp\n")).toBe("/help");
  });

  it("caps the length", () => {
    const long = `/${"a".repeat(1000)}`;
    expect(normalizePath(long)).toHaveLength(300);
  });

  it("refuses anything that is not a path on this site", () => {
    expect(normalizePath("https://evil.example/")).toBeNull();
    expect(normalizePath("//evil.example/x")).toBeNull();
    expect(normalizePath("pricing")).toBeNull();
    expect(normalizePath("")).toBeNull();
    expect(normalizePath(42)).toBeNull();
    expect(normalizePath(undefined)).toBeNull();
  });
});

describe("referrerHost", () => {
  const own = ["curvi.ai", "localhost:3100"];

  it("keeps only the host, without www.", () => {
    expect(referrerHost("https://www.google.com/search?q=curvi", own)).toBe("google.com");
    expect(referrerHost("https://news.ycombinator.com/item?id=1", own)).toBe("news.ycombinator.com");
    expect(referrerHost("http://Example.COM:8080/a/b", own)).toBe("example.com");
  });

  it("drops this site's own host, with or without www. and a port", () => {
    expect(referrerHost("https://curvi.ai/pricing", own)).toBeNull();
    expect(referrerHost("https://www.curvi.ai/", own)).toBeNull();
    expect(referrerHost("http://localhost:3100/help", own)).toBeNull();
  });

  it("drops empty values, non web addresses and junk", () => {
    expect(referrerHost("", own)).toBeNull();
    expect(referrerHost(undefined, own)).toBeNull();
    expect(referrerHost("android-app://com.google.android.gm/", own)).toBeNull();
    expect(referrerHost("not a url", own)).toBeNull();
  });
});

describe("cleanUtm", () => {
  it("trims, lower cases and caps the value, and drops an empty one", () => {
    expect(cleanUtm("  Newsletter ")).toBe("newsletter");
    expect(cleanUtm("x".repeat(500))).toHaveLength(100);
    expect(cleanUtm("   ")).toBeNull();
    expect(cleanUtm(undefined)).toBeNull();
    expect(cleanUtm(7)).toBeNull();
  });
});

describe("deviceClass", () => {
  it("tells phones, tablets and computers apart", () => {
    expect(deviceClass(CHROME_DESKTOP)).toBe("desktop");
    expect(deviceClass(IPHONE)).toBe("mobile");
    expect(deviceClass(ANDROID_PHONE)).toBe("mobile");
    expect(deviceClass(ANDROID_TABLET)).toBe("tablet");
    expect(deviceClass(IPAD)).toBe("tablet");
  });

  it("trusts the Sec-CH-UA-Mobile hint", () => {
    expect(deviceClass(CHROME_DESKTOP, "?1")).toBe("mobile");
    expect(deviceClass(CHROME_DESKTOP, "?0")).toBe("desktop");
  });
});

describe("bot and prefetch filtering", () => {
  const withHeaders = (entries: Record<string, string>) => new Headers(entries);

  it("counts a normal browser", () => {
    expect(visitSkipReason(withHeaders({ "user-agent": CHROME_DESKTOP }))).toBeNull();
    expect(visitSkipReason(withHeaders({ "user-agent": IPHONE }))).toBeNull();
  });

  it("skips a request with no user agent", () => {
    expect(visitSkipReason(withHeaders({}))).toBe("no_user_agent");
    expect(visitSkipReason(withHeaders({ "user-agent": "   " }))).toBe("no_user_agent");
  });

  it("skips crawlers, link previews and headless browsers", () => {
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      "curl/8.7.1",
      "python-requests/2.32.3",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36",
    ]) {
      expect(visitSkipReason(withHeaders({ "user-agent": ua })), ua).toBe("bot");
    }
  });

  it("skips prefetches and prerenders", () => {
    expect(isPrefetch(withHeaders({ purpose: "prefetch" }))).toBe(true);
    expect(isPrefetch(withHeaders({ "sec-purpose": "prefetch;prerender" }))).toBe(true);
    expect(isPrefetch(withHeaders({ "x-moz": "prefetch" }))).toBe(true);
    expect(isPrefetch(withHeaders({ "x-purpose": "preview" }))).toBe(true);
    expect(isPrefetch(withHeaders({}))).toBe(false);
    expect(visitSkipReason(withHeaders({ "user-agent": CHROME_DESKTOP, "sec-purpose": "prefetch" }))).toBe("prefetch");
  });
});

describe("buildVisitPayload", () => {
  it("sends the path, the UTM tags and the referrer when given", () => {
    expect(
      buildVisitPayload(
        { pathname: "/pricing", search: "?utm_source=Newsletter&utm_medium=email&utm_campaign=launch&email=a%40b.com" },
        "https://news.ycombinator.com/",
      ),
    ).toEqual({
      path: "/pricing",
      referrer: "https://news.ycombinator.com/",
      utm_source: "Newsletter",
      utm_medium: "email",
      utm_campaign: "launch",
    });
  });

  it("leaves out what is missing and never copies other query values", () => {
    const payload = buildVisitPayload({ pathname: "/", search: "?email=a%40b.com&utm_source=" }, null);
    expect(payload).toEqual({ path: "/" });
    expect(JSON.stringify(payload)).not.toContain("a@b.com");
  });
});
