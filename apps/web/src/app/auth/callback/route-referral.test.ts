import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// P18-24: on a fresh verification the callback hands the signup link's ref
// to the referral step (lib/referrals/signup.ts, which checks the switch and
// never throws), from the signup metadata or Google's attr.

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email_confirmed_at: string; created_at: string; user_metadata: Record<string, unknown> },
}));
const referral = vi.hoisted(() => vi.fn(async () => null));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { exchangeCodeForSession: async () => ({ data: { user: state.user }, error: null }) },
  }),
}));
vi.mock("@/lib/services", () => ({ isDbMode: () => false }));
vi.mock("@/lib/free-preview/deps", () => ({ claimSignupPreview: async () => null }));
vi.mock("@/lib/referrals/signup", () => ({ recordSignupReferral: referral }));

const { GET } = await import("./route");

const USER = "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a093";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
  referral.mockClear();
  const now = Date.now();
  state.user = {
    id: USER,
    created_at: new Date(now - 60_000).toISOString(),
    email_confirmed_at: new Date(now - 5_000).toISOString(),
    user_metadata: { attribution: { ref: "abcd2345", source: "home" } },
  };
});

describe("GET /auth/callback referrals", () => {
  it("passes the signup's ref and the new user to the referral step", async () => {
    const response = await GET(new NextRequest("https://curvi.ai/auth/callback?code=abc"));
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/welcome");
    expect(referral).toHaveBeenCalledWith("abcd2345", USER);
  });

  it("reads Google's attr when the metadata has no hint", async () => {
    state.user = { ...(state.user as NonNullable<typeof state.user>), user_metadata: {} };
    const attr = Buffer.from(JSON.stringify({ ref: "efgh6789" })).toString("base64url");
    await GET(new NextRequest(`https://curvi.ai/auth/callback?code=abc&attr=${attr}`));
    expect(referral).toHaveBeenCalledWith("efgh6789", USER);
  });

  it("does not run on a later sign in", async () => {
    state.user = {
      ...(state.user as NonNullable<typeof state.user>),
      email_confirmed_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    };
    await GET(new NextRequest("https://curvi.ai/auth/callback?code=abc"));
    expect(referral).not.toHaveBeenCalled();
  });
});
