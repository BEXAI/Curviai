import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

// The function Next.js itself uses to turn config.matcher into the regular
// expressions the middleware runs on, so this test reads the matcher the
// way the server does, whatever entries later phases add. It is internal
// (no type declaration), hence the typed require.
const { getMiddlewareMatchers } = createRequire(import.meta.url)("next/dist/build/analysis/get-page-static-info") as {
  getMiddlewareMatchers: (matcher: unknown, nextConfig: object) => Array<{ regexp: string }>;
};

vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn() }));

import { config } from "./middleware";

// docs/phases/PHASE_20.md P20-13: Sentry's tunnel route (/monitoring, set
// as next.config.ts tunnelRoute when P20-14 ships the browser SDK; off in
// Release 2, security review 4) must never run the middleware, or browser
// error reports would pay for a session refresh and could be redirected to
// /login. Only this is pinned, so PHASE_19's /oauth/:path* and P20-57's
// /api/:path* can join the matcher. Once an /api entry exists, /api/health
// must stay out too (Render polls it every few seconds).

const TUNNEL_PATHS = ["/monitoring", "/monitoring/", "/monitoring/envelope", "/monitoring.rsc"];

function matches(pathname: string): boolean {
  return getMiddlewareMatchers(config.matcher, {}).some((matcher) => new RegExp(matcher.regexp).test(pathname));
}

describe("middleware matcher", () => {
  it.each(TUNNEL_PATHS)("never matches the Sentry tunnel path %s", (pathname) => {
    expect(matches(pathname)).toBe(false);
  });

  it("never matches the health check", () => {
    expect(matches("/api/health")).toBe(false);
  });

  it("still matches the pages it guards (the check reads the real matcher)", () => {
    expect(matches("/app/billing")).toBe(true);
    expect(matches("/login")).toBe(true);
  });
});
