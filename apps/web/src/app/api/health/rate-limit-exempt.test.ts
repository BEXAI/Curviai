import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { config as middlewareConfig } from "@/middleware";
import {
  RATE_LIMIT_EXEMPT_PATHS,
  isRateLimitExempt,
  limitByIp,
  type RateLimitStore,
} from "@/lib/rate-limit";

// Render polls /api/health every few seconds and counts a 429 as a failed
// check: 15 seconds of failures stop traffic, 60 seconds restart the
// instance. These tests keep every path to a 429 closed for it.

/** A store that says every caller is far over every limit. */
function exhaustedStore(): RateLimitStore & { calls: number } {
  const store = {
    calls: 0,
    async increment(): Promise<number> {
      store.calls += 1;
      return 1_000_000;
    },
  };
  return store;
}

function request(path: string): Request {
  return new Request(`https://curvi.ai${path}`, { headers: { "x-forwarded-for": "203.0.113.9" } });
}

/** Whether a Next.js middleware matcher entry covers a path. Only the forms
 * this app uses are understood; anything else counts as covering, so a new
 * catch all matcher fails this test until someone checks it. */
function matcherCovers(pattern: string, path: string): boolean {
  if (pattern.endsWith("/:path*")) {
    const base = pattern.slice(0, -"/:path*".length);
    if (/[:()*?+[\]]/.test(base)) {
      return true;
    }
    return path === base || path.startsWith(`${base}/`);
  }
  if (/[:()*?+[\]]/.test(pattern)) {
    return true;
  }
  return path === pattern;
}

describe("/api/health is never rate limited", () => {
  it("is on the exempt list, with or without a trailing slash", () => {
    expect(RATE_LIMIT_EXEMPT_PATHS).toContain("/api/health");
    expect(isRateLimitExempt("/api/health")).toBe(true);
    expect(isRateLimitExempt("/api/health/")).toBe(true);
    expect(isRateLimitExempt("/api/jobs")).toBe(false);
    expect(isRateLimitExempt("/api/healthz")).toBe(false);
  });

  it("passes the IP limiter even when every counter is exhausted", async () => {
    const store = exhaustedStore();
    expect(await limitByIp(request("/api/health"), "jobs.create", { store })).toBeNull();
    expect(await limitByIp(request("/api/health?probe=render"), "jobs.create", { store })).toBeNull();
    expect(store.calls).toBe(0);

    // The same store does limit a normal route.
    const limited = await limitByIp(request("/api/jobs"), "jobs.create", { store });
    expect(limited?.status).toBe(429);
  });

  it("calls no limiter in the route", () => {
    const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from "@\/lib\/rate-limit"/);
    expect(source).not.toMatch(/limitBy(Ip|User)|checkRateLimit/);
  });

  it("is outside the middleware matcher", () => {
    const matchers = ([] as string[]).concat(middlewareConfig.matcher);
    expect(matchers.length).toBeGreaterThan(0);
    for (const pattern of matchers) {
      expect(matcherCovers(pattern, "/api/health"), pattern).toBe(false);
    }
    // The helper itself recognizes a matcher that would cover it.
    expect(matcherCovers("/api/:path*", "/api/health")).toBe(true);
    expect(matcherCovers("/((?!_next).*)", "/api/health")).toBe(true);
  });
});
