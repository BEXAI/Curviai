import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// GET /r/<code> (P18-24): the home page with the code while referrals are
// on; the plain home page while they are off or for a malformed code.

const state = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/referrals/switch", () => ({ referralsOn: async () => state.on }));

const { GET } = await import("./route");

async function visit(code: string): Promise<Response> {
  return GET(new NextRequest(`https://curvi.ai/r/${encodeURIComponent(code)}`), { params: Promise.resolve({ code }) });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
  state.on = true;
});

describe("GET /r/<code>", () => {
  it("lands on the home page carrying the code and the referral tags, never cached or indexed", async () => {
    const response = await visit("ABCD2345");
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("location") ?? "");
    expect(target.origin).toBe("https://curvi.ai");
    expect(target.pathname).toBe("/");
    expect(Object.fromEntries(target.searchParams)).toEqual({
      ref: "abcd2345",
      utm_source: "referral",
      utm_medium: "referral",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("drops the code while referrals are off and for a malformed code", async () => {
    state.on = false;
    expect(new URL((await visit("abcd2345")).headers.get("location") ?? "").search).toBe("");
    state.on = true;
    for (const bad of ["x", "../../evil", "https://evil.com"]) {
      const target = new URL((await visit(bad)).headers.get("location") ?? "");
      expect(target.origin).toBe("https://curvi.ai");
      expect(target.pathname).toBe("/");
      expect(target.search).toBe("");
    }
  });
});
