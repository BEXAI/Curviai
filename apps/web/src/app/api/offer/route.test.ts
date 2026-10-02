import { afterEach, describe, expect, it, vi } from "vitest";
import { resetFoundingOfferForTests } from "@/lib/offer/founding";
import { GET } from "./route";

// GET /api/offer (docs/phases/PHASE_18.md P18-21): the banner view or null,
// cached by browsers for the seeded minute, never a reason or a Stripe id.

afterEach(() => {
  vi.unstubAllEnvs();
  resetFoundingOfferForTests();
});

describe("GET /api/offer", () => {
  it("answers no banner in demo mode with a public 60 second cache", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const body = await res.json();
    expect(body).toEqual({ founding: null });
    expect(JSON.stringify(body)).not.toMatch(/reason|switch|promo_/);
  });
});
