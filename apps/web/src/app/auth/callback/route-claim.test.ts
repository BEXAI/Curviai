import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// P18-04: a fresh signup whose link carried a prospect claim token redeems
// it at the callback and continues to /app/new on the claimed product. A
// free preview claim (P18-12) wins when both are present; a refused claim
// leaves the plain welcome.

type Exchange = (code: string) => Promise<{ data?: unknown; error: { message: string } | null }>;
let supabase: { auth: { exchangeCodeForSession: Exchange } } | null;

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => supabase }));
const preview = vi.hoisted(() => vi.fn(async (): Promise<{ productId: string } | null> => null));
vi.mock("@/lib/free-preview/deps", () => ({ claimSignupPreview: preview }));
const prospect = vi.hoisted(() => vi.fn(async (): Promise<{ productId: string } | null> => null));
vi.mock("@/lib/prospects/runtime", () => ({ claimSignupProspect: prospect }));

const { GET } = await import("./route");

const TOKEN = "0123456789abcdef0123456789abcdef01234567";
const PRODUCT = "0b7a4d1e-5c3f-4a2b-9e8d-7c6b5a4f3e2d";
const fresh = { id: "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a090", email_confirmed_at: new Date().toISOString(), app_metadata: {} };

function attr(hint: Record<string, string>): string {
  return Buffer.from(JSON.stringify(hint)).toString("base64url");
}

async function callback(query: string): Promise<URL> {
  const response = await GET(new NextRequest(`https://curvi.ai/auth/callback?${query}`));
  return new URL(response.headers.get("location") ?? "");
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
  fresh.email_confirmed_at = new Date().toISOString();
  supabase = { auth: { exchangeCodeForSession: (async () => ({ data: { user: fresh }, error: null })) as Exchange } };
  preview.mockClear();
  prospect.mockClear();
});

describe("GET /auth/callback with a prospect claim (P18-04)", () => {
  it("redeems the claim and continues to /app/new on its product", async () => {
    prospect.mockResolvedValueOnce({ productId: PRODUCT });
    const target = await callback(`code=abc&next=%2Fapp&attr=${attr({ source: "concierge", claim: TOKEN })}`);
    expect(prospect).toHaveBeenCalledWith(TOKEN, fresh.id);
    expect(target.pathname).toBe("/welcome");
    expect(target.searchParams.get("next")).toBe(`/app/new?product=${PRODUCT}`);
  });

  it("lets a free preview claim win, and leaves the plain welcome when the claim is refused", async () => {
    preview.mockResolvedValueOnce({ productId: "11111111-2222-4333-8444-555555555555" });
    const both = await callback(`code=abc&attr=${attr({ claim: TOKEN, preview: "3c1f0e2d-4b5a-4c6d-8e7f-90a1b2c3d4e5" })}`);
    expect(both.searchParams.get("next")).toBe("/app/new?product=11111111-2222-4333-8444-555555555555");
    expect(prospect).not.toHaveBeenCalled();

    const refused = await callback(`code=abc&attr=${attr({ claim: TOKEN })}`);
    expect(refused.pathname).toBe("/welcome");
    expect(refused.searchParams.get("next")).toBeNull();
    expect(prospect).toHaveBeenCalledWith(TOKEN, fresh.id);
  });

  it("never claims for a sign in that is not a fresh verification", async () => {
    fresh.email_confirmed_at = "2026-01-01T00:00:00Z";
    await callback(`code=abc&attr=${attr({ claim: TOKEN })}`);
    expect(prospect).not.toHaveBeenCalled();
  });
});
