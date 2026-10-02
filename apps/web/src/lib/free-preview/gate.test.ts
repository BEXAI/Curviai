import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCapStore } from "@curvi/ai/testing";
import { freePreview, turnstileFallback } from "@curvi/pipeline/seed";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit";
import {
  bookPreviewSpend,
  freePreviewSwitchOn,
  previewCountKey,
  previewDayOpen,
  previewGate,
  previewIpHash,
  previewSetupGaps,
  previewSpendKey,
  releasePreviewSlot,
  reservePreviewSlot,
  resetFreePreviewSwitchForTests,
  type PreviewGateDeps,
} from "./gate";

// docs/phases/PHASE_18.md P18-12 and founder decision 6: the preview opens
// only when fully set up, switched on and with packs running, and the day's
// count and spend ceilings hold across every instance.

const NOW = new Date("2026-10-01T15:00:00Z");

const FULL_ENV = {
  NEXT_PUBLIC_FREE_PREVIEW: "1",
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "token",
  DATABASE_URL: "postgres://localhost/curvi",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  FAL_KEY: "fal",
  OPENAI_API_KEY: "sk",
};

function stubAll(env: Record<string, string>) {
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetFreePreviewSwitchForTests();
});

describe("setup", () => {
  it("is complete only with the flag, Upstash, the database, R2, a cutout key and an LLM key", () => {
    stubAll(FULL_ENV);
    expect(previewSetupGaps()).toEqual([]);
    for (const [name, gap] of [
      ["NEXT_PUBLIC_FREE_PREVIEW", "flag"],
      ["UPSTASH_REDIS_REST_TOKEN", "shared_limits"],
      ["DATABASE_URL", "database"],
      ["R2_SECRET_ACCESS_KEY", "storage"],
      ["FAL_KEY", "cutout"],
      ["OPENAI_API_KEY", "llm"],
    ] as const) {
      vi.stubEnv(name, "");
      expect(previewSetupGaps(), name).toEqual([gap]);
      vi.stubEnv(name, FULL_ENV[name]);
    }
    vi.stubEnv("NEXT_PUBLIC_FREE_PREVIEW", "true");
    expect(previewSetupGaps()).toEqual(["flag"]);
  });

  it("reads the backup fal key and either LLM key", () => {
    stubAll({ ...FULL_ENV, FAL_KEY: "", FAL_KEY_BACKUP: "fal2", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "ak" });
    expect(previewSetupGaps()).toEqual([]);
  });
});

describe("switch", () => {
  it("opens on a stored true or no row (its ops: default), caches for 30 seconds and closes on a failed read", async () => {
    let t = 0;
    const read = vi.fn(async () => true);
    expect(await freePreviewSwitchOn(read, () => t)).toBe(true);
    t = 29_000;
    expect(await freePreviewSwitchOn(async () => false, () => t)).toBe(true);
    t = 31_000;
    expect(await freePreviewSwitchOn(async () => "true", () => t)).toBe(false);
    resetFreePreviewSwitchForTests();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      await freePreviewSwitchOn(async () => {
        throw new Error("db down");
      }),
    ).toBe(false);
    // P20-20: no row means the operator switch's default, which is on.
    resetFreePreviewSwitchForTests();
    expect(await freePreviewSwitchOn(async () => undefined)).toBe(true);
    resetFreePreviewSwitchForTests();
    expect(await freePreviewSwitchOn(async () => null)).toBe(false);
  });
});

describe("daily caps (decision 6)", () => {
  it("atomically holds the stricter unprotected production count and shares the existing counter", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    const store = new InMemoryCapStore();
    await store.add(previewCountKey(NOW), turnstileFallback.previewSitePerDay - 1);
    expect(await reservePreviewSlot(store, NOW)).toBe(true);
    expect(await reservePreviewSlot(store, NOW)).toBe(false);
    expect(await store.get(previewCountKey(NOW))).toBe(turnstileFallback.previewSitePerDay);
    expect(await previewDayOpen(store, NOW)).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "site-key");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret-key");
    expect(await previewDayOpen(store, NOW)).toBe(true);
    expect(await store.get(previewCountKey(NOW))).toBe(turnstileFallback.previewSitePerDay);
  });

  it("take the seeded number of previews a day, site wide, and give an overshoot back", async () => {
    const store = new InMemoryCapStore();
    await store.add(previewCountKey(NOW), freePreview.sitePerDay - 1);
    expect(await reservePreviewSlot(store, NOW)).toBe(true);
    expect(await reservePreviewSlot(store, NOW)).toBe(false);
    expect(await store.get(previewCountKey(NOW))).toBe(freePreview.sitePerDay);
    expect(await previewDayOpen(store, NOW)).toBe(false);
    await releasePreviewSlot(store, NOW);
    expect(await previewDayOpen(store, NOW)).toBe(true);
    // The next UTC day starts empty.
    expect(await reservePreviewSlot(store, new Date("2026-10-02T00:00:01Z"))).toBe(true);
  });

  it("close once the day's booked spend reaches the seeded ceiling", async () => {
    const store = new InMemoryCapStore();
    await bookPreviewSpend(store, NOW, freePreview.siteSpendPerDayMicros - 1);
    expect(await reservePreviewSlot(store, NOW)).toBe(true);
    await bookPreviewSpend(store, NOW, 11_000);
    expect(await store.get(previewSpendKey(NOW))).toBe(freePreview.siteSpendPerDayMicros + 10_999);
    expect(await reservePreviewSlot(store, NOW)).toBe(false);
    expect(await previewDayOpen(store, NOW)).toBe(false);
    await bookPreviewSpend(store, NOW, 0);
    expect(previewSpendKey(NOW)).toBe("preview:spend:2026-10-01");
    expect(previewCountKey(NOW)).toBe("preview:day:2026-10-01");
  });

  it("cap each IP at the seeded previews per UTC day", () => {
    const policy = RATE_LIMIT_POLICIES["preview.create"];
    expect(policy.ip).toEqual({ limit: freePreview.perIpPerDay, windowSeconds: 86_400 });
    expect(freePreview.perIpPerDay).toBe(3);
    expect(freePreview.sitePerDay).toBe(300);
  });
});

describe("gate", () => {
  let deps: PreviewGateDeps;
  beforeEach(() => {
    deps = {
      setupGaps: () => [],
      switchOn: async () => true,
      acquisitionOpen: async () => true,
      counters: new InMemoryCapStore(),
      now: () => NOW,
    };
  });

  it("is open when everything holds", async () => {
    expect(await previewGate(deps)).toEqual({ open: true });
  });

  it("names the first closed gate, in the plan's order", async () => {
    expect(await previewGate({ ...deps, setupGaps: () => ["flag"], switchOn: async () => false })).toEqual({
      open: false,
      reason: "not_set_up",
    });
    expect(await previewGate({ ...deps, switchOn: async () => false })).toEqual({ open: false, reason: "switched_off" });
    expect(await previewGate({ ...deps, acquisitionOpen: async () => false })).toEqual({
      open: false,
      reason: "packs_paused",
    });
    expect(
      await previewGate({
        ...deps,
        acquisitionOpen: async () => {
          throw new Error("preflight failed");
        },
      }),
    ).toEqual({ open: false, reason: "packs_paused" });
    const full = new InMemoryCapStore();
    await full.add(previewCountKey(NOW), freePreview.sitePerDay);
    expect(await previewGate({ ...deps, counters: full })).toEqual({ open: false, reason: "daily_limit" });
    expect(await previewGate({ ...deps, counters: full }, { checkDay: false })).toEqual({ open: true });
  });
});

describe("IP hash", () => {
  it("is 32 hex characters, never the address, stable within a UTC day and new the next day", () => {
    const a = previewIpHash("203.0.113.10", NOW);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toContain("203");
    expect(previewIpHash("203.0.113.10", new Date("2026-10-01T23:59:59Z"))).toBe(a);
    expect(previewIpHash("203.0.113.11", NOW)).not.toBe(a);
    expect(previewIpHash("203.0.113.10", new Date("2026-10-02T00:00:00Z"))).not.toBe(a);
  });
});
