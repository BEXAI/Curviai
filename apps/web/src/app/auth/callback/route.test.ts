import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_ERROR_MESSAGES } from "@/lib/safe-next";

type Exchange = (code: string) => Promise<{ error: { message: string } | null }>;

let supabase: { auth: { exchangeCodeForSession: Exchange; getUser?: () => Promise<unknown> } } | null;

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => supabase,
}));

const claim = vi.hoisted(() => ({
  fn: vi.fn<(previewId: string | null | undefined, userId: string | null) => Promise<{ productId: string } | null>>(
    async () => null,
  ),
}));
vi.mock("@/lib/free-preview/deps", () => ({ claimSignupPreview: claim.fn }));

const { GET } = await import("./route");

function callback(query: string) {
  return GET(new NextRequest(`https://curvi.ai/auth/callback?${query}`));
}

function location(response: Response): URL {
  return new URL(response.headers.get("location") ?? "");
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
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

  it("sends a canceled or refused Google sign in to /login with a fixed code (P18-13)", async () => {
    const target = location(await callback("error=access_denied&error_description=Call%20555%200100&next=%2Fapp%2Fnew&via=google"));
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("error")).toBe("oauth_failed");
    expect(target.searchParams.get("next")).toBe("/app/new");
    expect(target.toString()).not.toContain("555");
    expect(AUTH_ERROR_MESSAGES.oauth_failed).toContain("Google sign in did not finish");
  });

  it("tells an expired email link apart from Google: no via marker means link_invalid", async () => {
    const target = location(
      await callback("error=access_denied&error_code=otp_expired&error_description=Email%20link%20is%20invalid%20or%20has%20expired&next=%2Fapp"),
    );
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("error")).toBe("link_invalid");
    expect(target.toString()).not.toContain("expired");
  });

  it("sends a fresh signup to /welcome with the answers a category or channel page preselected (P18-20)", async () => {
    const fresh = { id: "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a090", email_confirmed_at: new Date().toISOString() };
    supabase = {
      auth: {
        exchangeCodeForSession: (async () => ({ data: { user: fresh }, error: null })) as unknown as Exchange,
      },
    };
    const target = location(await callback("code=abc&next=%2Fapp&category=candles&channel=amazon&attr=x"));
    expect(target.pathname).toBe("/welcome");
    expect(target.searchParams.get("category")).toBe("candles");
    expect(target.searchParams.get("channel")).toBe("amazon");
    expect(target.searchParams.has("attr")).toBe(false);
    const odd = location(await callback("code=abc&category=sports&channel=myspace"));
    expect(odd.pathname).toBe("/welcome");
    expect([...odd.searchParams.keys()]).toEqual([]);
  });

  it("finishes an email signup confirmed at once, signed in and without a code, like a confirmation link", async () => {
    const PREVIEW = "3c1f0e2d-4b5a-4c6d-8e7f-90a1b2c3d4e5";
    const fresh = { id: "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a090", email_confirmed_at: new Date().toISOString() };
    const exchange = vi.fn<Exchange>(async () => ({ error: null }));
    supabase = { auth: { exchangeCodeForSession: exchange, getUser: async () => ({ data: { user: fresh }, error: null }) } };
    claim.fn.mockClear();
    const attr = Buffer.from(JSON.stringify({ preview: PREVIEW })).toString("base64url");
    const target = location(await callback(`next=%2Fapp&category=candles&attr=${attr}`));
    expect(exchange).not.toHaveBeenCalled();
    expect(target.pathname).toBe("/welcome");
    expect(target.searchParams.get("category")).toBe("candles");
    expect(claim.fn).toHaveBeenCalledWith(PREVIEW, fresh.id);
  });

  it("sends a visitor who is not signed in and has no code on to the destination", async () => {
    supabase = { auth: { exchangeCodeForSession: vi.fn<Exchange>(async () => ({ error: null })), getUser: async () => ({ data: { user: null }, error: null }) } };
    const target = location(await callback("next=%2Fapp%2Fnew"));
    expect(target.pathname).toBe("/app/new");
  });

  it("claims a free preview the signup link carried and continues to /app/new on its product (P18-12)", async () => {
    const PREVIEW = "3c1f0e2d-4b5a-4c6d-8e7f-90a1b2c3d4e5";
    const PRODUCT = "0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d";
    const fresh = {
      id: "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a090",
      email_confirmed_at: new Date().toISOString(),
      app_metadata: { provider: "google" },
    };
    supabase = {
      auth: {
        exchangeCodeForSession: (async () => ({ data: { user: fresh }, error: null })) as unknown as Exchange,
      },
    };
    claim.fn.mockResolvedValueOnce({ productId: PRODUCT });
    const attr = Buffer.from(JSON.stringify({ preview: PREVIEW, utm_source: "reddit" })).toString("base64url");
    const target = location(await callback(`code=abc&next=%2Fapp&attr=${attr}`));
    expect(claim.fn).toHaveBeenCalledWith(PREVIEW, fresh.id);
    expect(target.pathname).toBe("/welcome");
    expect(target.searchParams.get("next")).toBe(`/app/new?product=${PRODUCT}`);

    // A pricing checkout keeps its destination; the claimed product waits on the dashboard.
    claim.fn.mockResolvedValueOnce({ productId: PRODUCT });
    const checkout = location(
      await callback(`code=abc&next=${encodeURIComponent("/app/billing?checkout=growth&cadence=annual")}&attr=${attr}`),
    );
    expect(checkout.searchParams.get("next")).toBe("/app/billing?checkout=growth&cadence=annual");

    // No preview, no claim call that does anything: the plain welcome.
    claim.fn.mockClear();
    const plain = location(await callback("code=abc"));
    expect(plain.pathname).toBe("/welcome");
    expect(claim.fn).toHaveBeenCalledWith(undefined, fresh.id);
  });

  it("answers the unconfigured state with the unavailable code", async () => {
    supabase = null;
    const target = location(await callback("code=abc"));
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("error")).toBe("unavailable");
  });
});
