import { afterEach, describe, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({ db: false }));
vi.mock("@/lib/services", () => ({ isDbMode: () => mode.db }));
vi.mock("@/lib/services/db", () => ({
  getDb: () => {
    throw new Error("no database in this test");
  },
}));

const { STORE_AUDIT_SWITCH_CACHE_MS, resetStoreAuditSwitchForTests, storeAuditEnabled, storeAuditSwitchOn } = await import(
  "./switch"
);

afterEach(() => {
  resetStoreAuditSwitchForTests();
  mode.db = false;
});

describe("store audit switch (P18-18)", () => {
  it("is on only for a stored true", async () => {
    for (const [value, on] of [
      [true, true],
      [false, false],
      [undefined, false],
      ["true", false],
      [1, false],
    ] as const) {
      resetStoreAuditSwitchForTests();
      expect(await storeAuditSwitchOn(async () => value), String(value)).toBe(on);
    }
  });

  it("fails closed when the read throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      await storeAuditSwitchOn(async () => {
        throw new Error("down");
      }),
    ).toBe(false);
    warn.mockRestore();
  });

  it("caches the read for a while", async () => {
    let now = 1_000;
    const read = vi.fn(async () => true);
    expect(await storeAuditSwitchOn(read, () => now)).toBe(true);
    now += STORE_AUDIT_SWITCH_CACHE_MS - 1;
    await storeAuditSwitchOn(read, () => now);
    expect(read).toHaveBeenCalledTimes(1);
    now += 2;
    await storeAuditSwitchOn(read, () => now);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("is on in the in memory demo, and off in production without ALLOW_DEMO_MODE", async () => {
    expect(await storeAuditEnabled()).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_DEMO_MODE", "");
    try {
      expect(await storeAuditEnabled()).toBe(false);
      vi.stubEnv("ALLOW_DEMO_MODE", "1");
      expect(await storeAuditEnabled()).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is off in db mode when the read fails", async () => {
    mode.db = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await storeAuditEnabled()).toBe(false);
    warn.mockRestore();
  });
});
