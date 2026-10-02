import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freePreview, storeAudit, turnstileFallback } from "@curvi/pipeline/seed";

const challenge = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("@/lib/turnstile", async (original) => ({
  ...(await original<typeof import("@/lib/turnstile")>()),
  verifyTurnstile: challenge.verify,
}));
const { anonymousSpendCheck, anonymousSpendLimits } = await import("./anonymous-spend");

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
  vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
  vi.stubEnv("TURNSTILE_SECRET_KEY", "");
  challenge.verify.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("anonymous work guard", () => {
  it("uses strict fallback caps only for unprotected production traffic", () => {
    const normal = {
      previewPerIpPerDay: freePreview.perIpPerDay, previewSitePerDay: freePreview.sitePerDay,
      storeAuditsPerIpPerHour: storeAudit.auditsPerIpPerHour, storeAuditsPerDay: storeAudit.auditsPerDay,
    };
    expect(anonymousSpendLimits()).toEqual(normal);
    vi.stubEnv("NODE_ENV", "production");
    expect(anonymousSpendLimits()).toEqual(turnstileFallback);
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "site-key");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret-key");
    expect(anonymousSpendLimits()).toEqual(normal);
  });

  it("rejects the direct origin before verification even with a token", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "site-key");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret-key");
    const refusal = await anonymousSpendCheck(new Request("https://curvi.onrender.com/api/preview"), "token", "preview");
    expect(refusal?.status).toBe(403);
    expect(challenge.verify).not.toHaveBeenCalled();
  });

  it("does not call the verifier in fallback mode and refuses partial configuration", async () => {
    const request = new Request("https://curvi.ai/api/preview");
    expect(await anonymousSpendCheck(request, undefined, "preview")).toBeNull();
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret-key");
    expect((await anonymousSpendCheck(request, "token", "preview"))?.status).toBe(503);
    expect(challenge.verify).not.toHaveBeenCalled();
  });
});
