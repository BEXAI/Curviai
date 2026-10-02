import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// P18-01 and P18-02: on a fresh verification the callback records where the
// signup came from and funnel.signup_confirmed (lib/services/attribution.ts,
// which keeps it once per user). A later sign in through a link records
// nothing, and neither does demo mode.

type User = {
  id: string;
  created_at: string;
  email_confirmed_at: string | null;
  user_metadata: Record<string, unknown>;
};

const state = vi.hoisted(() => ({ dbMode: true, user: null as User | null }));
const recordSignupConfirmed = vi.hoisted(() => vi.fn(async () => "written"));
const fakeDb = vi.hoisted(() => ({ marker: "db" }));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { exchangeCodeForSession: async () => ({ data: { user: state.user }, error: null }) },
  }),
}));
vi.mock("@/lib/services", () => ({ isDbMode: () => state.dbMode }));
vi.mock("@/lib/services/db", () => ({ getDb: () => fakeDb }));
vi.mock("@/lib/trust/terms", () => ({ recordTermsAcceptanceSafely: vi.fn(async () => undefined) }));
vi.mock("@/lib/services/attribution", () => ({ recordSignupConfirmed }));

const { GET } = await import("./route");

const USER_ID = "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a091";

function user(confirmedMsAgo: number): User {
  const now = Date.now();
  return {
    id: USER_ID,
    created_at: new Date(now - confirmedMsAgo - 60_000).toISOString(),
    email_confirmed_at: new Date(now - confirmedMsAgo).toISOString(),
    user_metadata: { attribution: { source: "home", utm_source: "reddit" } },
  };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
  recordSignupConfirmed.mockClear();
  state.dbMode = true;
  state.user = null;
});

describe("GET /auth/callback attribution", () => {
  it("records the signup once on a fresh verification, passing Google's attr through", async () => {
    state.user = user(5_000);
    const response = await GET(new NextRequest("https://curvi.ai/auth/callback?code=abc&attr=eyJzb3VyY2UiOiJob21lIn0"));
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/welcome");
    expect(recordSignupConfirmed).toHaveBeenCalledTimes(1);
    expect(recordSignupConfirmed).toHaveBeenCalledWith(fakeDb, {
      user: state.user,
      attrParam: "eyJzb3VyY2UiOiJob21lIn0",
    });
  });

  it("records nothing for a sign in long after the email was confirmed", async () => {
    state.user = user(3 * 24 * 60 * 60 * 1000);
    await GET(new NextRequest("https://curvi.ai/auth/callback?code=abc"));
    expect(recordSignupConfirmed).not.toHaveBeenCalled();
  });

  it("records nothing without the database", async () => {
    state.dbMode = false;
    state.user = user(5_000);
    await GET(new NextRequest("https://curvi.ai/auth/callback?code=abc"));
    expect(recordSignupConfirmed).not.toHaveBeenCalled();
  });
});
