import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSameOrigin, sameOriginOrRefuse } from "./same-origin";

const signOut = vi.fn(async () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { signOut } }),
}));

function request(headers: Record<string, string>): Request {
  return new Request("https://curvi.ai/api/jobs", { method: "POST", headers });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
  signOut.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sameOriginOrRefuse", () => {
  it("allows a request with no Origin (server to server)", () => {
    expect(sameOriginOrRefuse(request({}))).toBeNull();
  });

  it("allows the site origin", () => {
    expect(isSameOrigin(request({ origin: "https://curvi.ai" }))).toBe(true);
  });

  it("allows the host the request was addressed to, such as a local port", () => {
    expect(isSameOrigin(request({ origin: "http://localhost:3100", host: "localhost:3100" }))).toBe(true);
  });

  it("refuses another site with a 403 and plain copy", async () => {
    const refused = sameOriginOrRefuse(request({ origin: "https://evil.example", host: "curvi.ai" }));
    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toEqual({
      error: "This request came from another site, so it was refused.",
      reason: "cross_site",
    });
  });

  it("refuses a look alike host, another scheme or port of the site, and an opaque origin", () => {
    for (const origin of ["https://curvi.ai.evil.example", "http://curvi.ai", "https://curvi.ai:8443", "null", "not a url"]) {
      expect(isSameOrigin(request({ origin, host: "app.internal" }))).toBe(false);
    }
  });
});

describe("POST /auth/signout", () => {
  it("refuses a sign out posted from another site and signs out a same site post", async () => {
    const { POST } = await import("@/app/auth/signout/route");
    const { NextRequest } = await import("next/server");
    const crossSite = await POST(
      new NextRequest("https://curvi.ai/auth/signout", { method: "POST", headers: { origin: "https://evil.example" } }),
    );
    expect(crossSite.status).toBe(403);
    expect(signOut).not.toHaveBeenCalled();

    const sameSite = await POST(
      new NextRequest("https://curvi.ai/auth/signout", { method: "POST", headers: { origin: "https://curvi.ai" } }),
    );
    expect(sameSite.status).toBe(303);
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
