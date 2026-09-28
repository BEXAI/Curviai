import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface CookieAdapter {
  setAll(cookies: Array<{ name: string; value: string; options?: Record<string, unknown> }>): void;
}

let signedIn = false;
let refreshSession = false;

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, options: { cookies: CookieAdapter }) => ({
    auth: {
      getUser: async () => {
        if (refreshSession) {
          options.cookies.setAll([{ name: "sb-test-auth-token", value: "rotated", options: { path: "/" } }]);
        }
        return { data: { user: signedIn ? { id: "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a090" } : null } };
      },
    },
  }),
}));

const { middleware, config } = await import("./middleware");

function visit(path: string) {
  return middleware(new NextRequest(`https://curvi.ai${path}`));
}

function location(response: Response): URL | null {
  const value = response.headers.get("location");
  return value ? new URL(value) : null;
}

beforeEach(() => {
  signedIn = false;
  refreshSession = false;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("middleware", () => {
  it("guards /app and the auth pages", () => {
    expect(config.matcher).toEqual(["/app/:path*", "/login", "/signup"]);
  });

  it("keeps the query string in next when a signed out visitor opens /app", async () => {
    const response = await visit("/app/billing?checkout=growth&cadence=annual");
    const target = location(response);
    expect(target?.pathname).toBe("/login");
    expect(target?.searchParams.get("next")).toBe("/app/billing?checkout=growth&cadence=annual");
    // Nothing else from the original query leaks onto /login.
    expect([...(target?.searchParams.keys() ?? [])]).toEqual(["next"]);
  });

  it("lets a signed out visitor reach /login and /signup", async () => {
    expect(location(await visit("/login?next=%2Fapp%2Fnew"))).toBeNull();
    expect(location(await visit("/signup?plan=growth"))).toBeNull();
  });

  it("sends a signed in visitor on /signup with a pricing intent to checkout", async () => {
    signedIn = true;
    const target = location(await visit("/signup?plan=growth&cadence=annual&source=pricing"));
    expect(target?.origin).toBe("https://curvi.ai");
    expect(target?.pathname).toBe("/app/billing");
    expect(target?.searchParams.get("checkout")).toBe("growth");
    expect(target?.searchParams.get("cadence")).toBe("annual");
  });

  it("sends a signed in visitor on /login to a safe next, never off site", async () => {
    signedIn = true;
    expect(location(await visit("/login?next=%2Fapp%2Fbrand"))?.pathname).toBe("/app/brand");
    const evil = location(await visit("/login?next=%2F%5Cevil.com"));
    expect(evil?.origin).toBe("https://curvi.ai");
    expect(evil?.pathname).toBe("/app");
  });

  it("lets a signed in member through to /app", async () => {
    signedIn = true;
    expect(location(await visit("/app/new"))).toBeNull();
  });

  it("carries refreshed session cookies onto a redirect", async () => {
    signedIn = true;
    refreshSession = true;
    const response = await visit("/login");
    expect(location(response)?.pathname).toBe("/app");
    expect(response.headers.get("set-cookie")).toContain("sb-test-auth-token=rotated");
  });

  it("passes everything through when Supabase is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    expect(location(await visit("/app/new"))).toBeNull();
  });
});
