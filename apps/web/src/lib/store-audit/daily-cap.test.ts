import { afterEach, describe, expect, it, vi } from "vitest";
import { storeAudit, turnstileFallback } from "@curvi/pipeline/seed";
import { MemoryRateLimitStore } from "@/lib/rate-limit";
import { takeDailyAudit } from "./daily-cap";

const DAY_MS = 24 * 3600 * 1000;
// One hour into a UTC day.
const T0 = Math.floor(Date.UTC(2026, 9, 1, 12) / DAY_MS) * DAY_MS + 3600 * 1000;
afterEach(() => vi.unstubAllEnvs());

describe("store audit daily cap (P18-18)", () => {
  it("halves the production daily allowance without a configured challenge", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    const store = new MemoryRateLimitStore();
    for (let i = 0; i < turnstileFallback.storeAuditsPerDay; i += 1) {
      expect((await takeDailyAudit({ store, nowMs: T0 })).allowed).toBe(true);
    }
    expect((await takeDailyAudit({ store, nowMs: T0 })).allowed).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "site-key");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret-key");
    expect((await takeDailyAudit({ store, nowMs: T0 })).allowed).toBe(true);
  });

  it("allows the seeded number of audits a UTC day, then refuses until the day ends", async () => {
    const store = new MemoryRateLimitStore();
    for (let index = 0; index < storeAudit.auditsPerDay; index += 1) {
      expect((await takeDailyAudit({ store, nowMs: T0 })).allowed).toBe(true);
    }
    const refused = await takeDailyAudit({ store, nowMs: T0 });
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(23 * 3600);
    expect((await takeDailyAudit({ store, nowMs: T0 + DAY_MS })).allowed).toBe(true);
  });
});
