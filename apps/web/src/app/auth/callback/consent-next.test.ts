import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { skipsWelcome } from "@/lib/verification";

// Sign up inside the ChatGPT connect flow (docs/phases/PHASE_19.md, P19-09,
// "Sign up inside the flow"): the confirmation link carries next under
// /oauth/consent, which goes straight back to the consent page instead of
// /welcome, and the callback still records the terms acceptance as for any
// signup. The free signup grant is paid by the database when the email is
// confirmed (migration 0012), whatever page comes next.

const recordTerms = vi.fn(async () => undefined);
let confirmedAt: string | null;

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      exchangeCodeForSession: async () => ({
        data: { user: { id: "00000000-0000-4000-8000-0000000000a1", created_at: confirmedAt, email_confirmed_at: confirmedAt } },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/services", () => ({ isDbMode: () => true }));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/trust/terms", () => ({ recordTermsAcceptanceSafely: recordTerms }));
vi.mock("@/lib/ads-conversions", () => ({ registrationConversion: () => null, sendAdsConversion: async () => undefined }));

const { GET } = await import("./route");

const CONSENT_NEXT = "/oauth/consent?authorization_id=AbCdEfGhIjKlMnOpQrStUvWxYz012345";

function location(response: Response): URL {
  return new URL(response.headers.get("location") ?? "");
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
  recordTerms.mockClear();
  confirmedAt = new Date().toISOString();
});

describe("GET /auth/callback with a consent next", () => {
  it("sends a freshly verified account straight back to the consent page, skipping /welcome", async () => {
    const response = await GET(new NextRequest(`https://curvi.ai/auth/callback?code=abc&next=${encodeURIComponent(CONSENT_NEXT)}`));
    const target = location(response);
    expect(target.origin).toBe("https://curvi.ai");
    expect(`${target.pathname}${target.search}`).toBe(CONSENT_NEXT);
  });

  it("still records the terms acceptance from the signup confirmation", async () => {
    await GET(new NextRequest(`https://curvi.ai/auth/callback?code=abc&next=${encodeURIComponent(CONSENT_NEXT)}`));
    expect(recordTerms).toHaveBeenCalledTimes(1);
    expect(recordTerms).toHaveBeenCalledWith({}, expect.objectContaining({ userId: "00000000-0000-4000-8000-0000000000a1", source: "signup_callback" }));
  });

  it("keeps the welcome page for every other destination", async () => {
    const response = await GET(new NextRequest(`https://curvi.ai/auth/callback?code=abc&next=${encodeURIComponent("/app/new")}`));
    expect(location(response).pathname).toBe("/welcome");
  });

  it("matches only the consent page itself", () => {
    expect(skipsWelcome("/oauth/consent")).toBe(true);
    expect(skipsWelcome(CONSENT_NEXT)).toBe(true);
    expect(skipsWelcome("/oauth/consentx")).toBe(false);
    expect(skipsWelcome("/oauth/consent/other")).toBe(false);
    expect(skipsWelcome("/app")).toBe(false);
  });
});
