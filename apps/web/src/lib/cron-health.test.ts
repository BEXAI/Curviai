import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@curvi/db";
import { createTestDb } from "@curvi/db/testing";
import { cronFreshness, cronSettingKey, readCronSuccesses, recordCronSuccess } from "./cron-health";

const NOW = new Date("2026-09-28T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

describe("cronFreshness", () => {
  it("is fresh within twice the interval, overdue after, and never without a run", () => {
    const statuses = cronFreshness({ "stale-jobs": minutesAgo(19), "purge-source-media": minutesAgo(2 * 24 * 60 + 1) }, NOW);
    expect(statuses).toEqual([
      { name: "stale-jobs", intervalMinutes: 10, lastSuccess: minutesAgo(19), ageMinutes: 19, state: "fresh" },
      {
        name: "purge-source-media",
        intervalMinutes: 1440,
        lastSuccess: minutesAgo(2881),
        ageMinutes: 2881,
        state: "overdue",
      },
    ]);
    expect(cronFreshness({ "stale-jobs": minutesAgo(21) }, NOW).map((s) => s.state)).toEqual(["overdue", "never"]);
    expect(cronFreshness({}, NOW).map((s) => s.ageMinutes)).toEqual([null, null]);
  });
});

describe("recording and reading cron runs", () => {
  let client: Awaited<ReturnType<typeof createTestDb>>["client"];
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];

  beforeAll(async () => {
    const created = await createTestDb();
    client = created.client;
    db = created.db;
  });

  afterAll(async () => {
    await client.close();
  });

  it("upserts one platform_settings row per cron and reads back the latest run", async () => {
    await recordCronSuccess(db as unknown as Db, "stale-jobs", new Date(minutesAgo(30)));
    await recordCronSuccess(db as unknown as Db, "stale-jobs", new Date(minutesAgo(5)));
    await recordCronSuccess(db as unknown as Db, "purge-source-media", new Date(minutesAgo(60)));
    // Other platform settings are ignored.
    await client.query(`insert into platform_settings (key, value) values ('free_signup_credits', '12') on conflict do nothing`);

    const successes = await readCronSuccesses(db);
    expect(successes).toEqual({ "stale-jobs": minutesAgo(5), "purge-source-media": minutesAgo(60) });
    const rows = await client.query<{ key: string }>(`select key from platform_settings where key = $1`, [cronSettingKey("stale-jobs")]);
    expect(rows.rows).toHaveLength(1);
    expect(cronFreshness(successes, NOW).map((s) => s.state)).toEqual(["fresh", "fresh"]);
  });

  it("never throws when the write fails", async () => {
    const warn = vi.fn();
    const broken = {
      insert: () => {
        throw new Error("database is down");
      },
    } as unknown as Db;
    await expect(recordCronSuccess(broken, "stale-jobs", NOW, { warn })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});
