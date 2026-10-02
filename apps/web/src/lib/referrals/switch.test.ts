import { afterEach, describe, expect, it, vi } from "vitest";
import { referralCodePolicy, REFERRALS_SETTING } from "@curvi/pipeline/seed";
import { platformSettings } from "@curvi/db/schema";
import { createTestDb } from "@curvi/db/testing";
import type { Db } from "@curvi/db";
import { readReferralsSwitch, referralsOn, resetReferralsSwitchForTests } from "./switch";

// referrals_enabled (P18-24): seeded off until founder decision 18, cached
// per process, and off on anything but a stored true.

afterEach(() => {
  resetReferralsSwitchForTests();
  vi.unstubAllEnvs();
});

describe("readReferralsSwitch", () => {
  it("is on only for a stored boolean true", async () => {
    const { client, db } = await createTestDb();
    try {
      expect(await readReferralsSwitch(db as unknown as Db)).toBe(false);
      await db.insert(platformSettings).values({ key: REFERRALS_SETTING, value: false });
      expect(await readReferralsSwitch(db as unknown as Db)).toBe(false);
      await client.query("update platform_settings set value = '\"true\"'::jsonb where key = $1", [REFERRALS_SETTING]);
      expect(await readReferralsSwitch(db as unknown as Db)).toBe(false);
      await client.query("update platform_settings set value = 'true'::jsonb where key = $1", [REFERRALS_SETTING]);
      expect(await readReferralsSwitch(db as unknown as Db)).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe("referralsOn", () => {
  it("caches the switch for the seeded seconds", async () => {
    let now = 0;
    const read = vi.fn(async () => true);
    expect(await referralsOn({ read, now: () => now })).toBe(true);
    now = referralCodePolicy.switchCacheSeconds * 1000 - 1;
    await referralsOn({ read, now: () => now });
    expect(read).toHaveBeenCalledTimes(1);
    now += 1;
    await referralsOn({ read, now: () => now });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("fails closed on a read error and in demo mode", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      await referralsOn({
        read: async () => {
          throw new Error("db down");
        },
      }),
    ).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    resetReferralsSwitchForTests();
    vi.stubEnv("DATABASE_URL", "");
    expect(await referralsOn()).toBe(false);
  });
});
