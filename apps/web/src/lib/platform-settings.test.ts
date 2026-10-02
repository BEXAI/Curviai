import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { platformSettings } from "@curvi/db";
import { createTestDb } from "@curvi/db/testing";
import { forgetOpsSwitch, opsSwitch } from "./features";
import { platformSettingReader, readPlatformSetting } from "./platform-settings";

describe("readPlatformSetting and opsSwitch on a real table", () => {
  let client: Awaited<ReturnType<typeof createTestDb>>["client"];
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];

  beforeAll(async () => {
    const created = await createTestDb();
    client = created.client;
    db = created.db;
    await db.insert(platformSettings).values([
      { key: "ops:packs_paused", value: { on: true, message: "Back soon", setBy: "ops@curvi.ai" } },
      { key: "ops:global_hard_stop_usd", value: 25 },
      { key: "ops:acquisition_paused", value: true },
    ]);
  });

  afterEach(() => {
    forgetOpsSwitch();
  });

  afterAll(async () => {
    await client.close();
  });

  it("returns the parsed stored value, or undefined for a missing row", async () => {
    expect(await readPlatformSetting(db, "ops:global_hard_stop_usd")).toBe(25);
    expect(await readPlatformSetting(db, "ops:packs_paused")).toEqual({
      on: true,
      message: "Back soon",
      setBy: "ops@curvi.ai",
    });
    expect(await readPlatformSetting(db, "ops:referrals_enabled")).toBeUndefined();
  });

  it("feeds opsSwitch, which falls back to the seed default for a missing row", async () => {
    const read = platformSettingReader(db);
    expect(await opsSwitch("ops:acquisition_paused", read)).toBe(true);
    expect(await opsSwitch("ops:global_hard_stop_usd", read)).toBe(25);
    expect((await opsSwitch("ops:packs_paused", read)).on).toBe(true);
    expect(await opsSwitch("ops:output_options_enabled", read)).toBe(true);
    expect(await opsSwitch("ops:deploy_pending", read)).toEqual({ on: false });
  });
});
