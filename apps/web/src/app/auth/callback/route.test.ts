import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_ERROR_MESSAGES } from "@/lib/safe-next";

type Exchange = (code: string) => Promise<{ error: { message: string } | null }>;

let supabase: { auth: { exchangeCodeForSession: Exchange } } | null;

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => supabase,
}));

const { GET } = await import("./route");

function callback(query: string) {
  return GET(new NextRequest(`https://curvi.ai/auth/callback?${query}`));
}

function location(response: Response): URL {
  return new URL(response.headers.get("location") ?? "");
}

beforeEach(() => {
  supabase = { auth: { exchangeCodeForSession: vi.fn<Exchange>(async () => ({ error: null })) } };
});

describe("GET /auth/callback (Update.md 4.3)", () => {
  it.each([
    "next=%2F%5Cevil.com",
    "next=%2F%255Cevil.com",
    "next=%2F%2Fevil.com",
    "next=https%3A%2F%2Fevil.com",
    "next=%2F%09%2Fevil.com",
    "next=%2F.%2F%2Fevil.com",
  ])("keeps %s on site", async (query) => {
    const response = await callback(`code=abc&${query}`);
    const target = location(response);
    expect(target.origin).toBe("https://curvi.ai");
    expect(target.pathname).toBe("/app");
  });

  it("continues to a safe in app path", async () => {
    const response = await callback(`code=abc&next=${encodeURIComponent("/app/jobs/0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d")}`);
    expect(location(response).pathname).toBe("/app/jobs/0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d");
  });

  it("carries a pricing checkout through the email confirmation link", async () => {
    const next = encodeURIComponent("/app/billing?checkout=growth&cadence=annual");
    const response = await callback(`code=abc&next=${next}`);
    const target = location(response);
    expect(target.pathname).toBe("/app/billing");
    expect(target.searchParams.get("checkout")).toBe("growth");
    expect(target.searchParams.get("cadence")).toBe("annual");
  });

  it("sends a failed exchange to /login with a fixed code, never provider text", async () => {
    supabase = {
      auth: { exchangeCodeForSession: async () => ({ error: { message: "Call 555 0100 to unlock your account" } }) },
    };
    const response = await callback("code=bad");
    const target = location(response);
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("error")).toBe("link_invalid");
    expect(response.headers.get("location")).not.toContain("555");
  });

  it("recovers from a thrown exchange", async () => {
    supabase = {
      auth: {
        exchangeCodeForSession: async () => {
          throw new TypeError("fetch failed");
        },
      },
    };
    const target = location(await callback("code=abc&next=%2Fapp%2Fbrand"));
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("error")).toBe("unavailable");
    expect(target.searchParams.get("next")).toBe("/app/brand");
    expect(AUTH_ERROR_MESSAGES.unavailable).toBeTruthy();
  });

  it("answers the unconfigured state with the unavailable code", async () => {
    supabase = null;
    const target = location(await callback("code=abc"));
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("error")).toBe("unavailable");
  });
});
