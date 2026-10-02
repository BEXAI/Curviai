import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@curvi/db";
import { createTestDb } from "@curvi/db/testing";
import { backup, billingReconcile, restoreDrill } from "@curvi/pipeline/seed";
import {
  CRON_JOBS,
  RESTORE_DRILL_RUN,
  restoreDrillWarning,
  cronFreshness,
  cronJobProblems,
  cronSettingKey,
  readCronSuccesses,
  recordCronSuccess,
  type CronJobDefinition,
} from "./cron-health";

const NOW = new Date("2026-09-28T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
// The two jobs from before Phase 20; later entries have their own tests.
const BASE_JOBS = CRON_JOBS.filter((job) => job.name === "stale-jobs" || job.name === "purge-source-media");

describe("cronFreshness", () => {
  it("is fresh within twice the interval, overdue after, and never without a run", () => {
    const statuses = cronFreshness({ "stale-jobs": minutesAgo(19), "purge-source-media": minutesAgo(2 * 24 * 60 + 1) }, NOW, BASE_JOBS);
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
    expect(cronFreshness({ "stale-jobs": minutesAgo(21) }, NOW, BASE_JOBS).map((s) => s.state)).toEqual(["overdue", "never"]);
    expect(cronFreshness({}, NOW, BASE_JOBS).map((s) => s.ageMinutes)).toEqual([null, null]);
  });

  it("goes overdue after the backup's seeded maxAgeHours, not twice its daily interval (P20-10)", () => {
    const backupJob = CRON_JOBS.filter((job) => job.name === "backup");
    expect(backupJob).toEqual([{ name: "backup", intervalMinutes: 1440, maxAgeMinutes: backup.maxAgeHours * 60 }]);
    const limit = backup.maxAgeHours * 60;
    expect(cronFreshness({ backup: minutesAgo(limit) }, NOW, backupJob)[0].state).toBe("fresh");
    expect(cronFreshness({ backup: minutesAgo(limit + 1) }, NOW, backupJob)[0]).toMatchObject({
      state: "overdue",
      ageMinutes: limit + 1,
    });
    expect(cronFreshness({}, NOW, backupJob)[0].state).toBe("never");
    expect(cronJobProblems({ name: "x", intervalMinutes: 5, maxAgeMinutes: 0 })).toEqual([
      "maxAgeMinutes must be a positive whole number",
    ]);
  });
});

describe("restoreDrillWarning (P20-11)", () => {
  const daysAgo = (d: number) => minutesAgo(d * 24 * 60);

  it("warns until a drill is recorded, stays quiet for the seeded days, then warns again", () => {
    expect(restoreDrillWarning({}, NOW)).toEqual({
      code: "restore_drill_overdue",
      message: "No restore drill has been recorded yet. Run pnpm ops:restore-drill (docs/ops/BACKUP_RESTORE.md).",
    });
    expect(restoreDrillWarning({ [RESTORE_DRILL_RUN]: daysAgo(restoreDrill.maxAgeDays) }, NOW)).toBeNull();
    expect(restoreDrillWarning({ [RESTORE_DRILL_RUN]: daysAgo(restoreDrill.maxAgeDays + 2) }, NOW)).toEqual({
      code: "restore_drill_overdue",
      message: `The last restore drill passed ${restoreDrill.maxAgeDays + 2} days ago. Run one at least every ${restoreDrill.maxAgeDays} days.`,
    });
  });

  it("is not a cron: never in CRON_JOBS, so no cron_never_ran for it", () => {
    expect(CRON_JOBS.map((job) => job.name)).not.toContain(RESTORE_DRILL_RUN);
  });
});

describe("the CRON_JOBS registry (P20-38 contract)", () => {
  it("keeps today's two jobs, PHASE_18's three, the billing reconcile (P20-02) and the backup (P20-10), and every entry is well formed", () => {
    expect(BASE_JOBS.map((job) => job.name)).toEqual(["stale-jobs", "purge-source-media"]);
    expect(CRON_JOBS.map((job) => job.name)).toEqual([
      "stale-jobs",
      "purge-source-media",
      "funnel-digest",
      "provider-balance",
      "lifecycle",
      "billing-reconcile",
      "recovery",
      "renewal-notices",
      "retention",
      "r2-legacy-sweep",
      "visit-salts",
      "ops-alerts",
      "upstash-keepalive",
      "provider-canary",
      "backup",
      "completion-webhooks",
    ]);
    expect(cronFreshness({}, NOW).filter((job) => ["funnel-digest", "provider-balance", "lifecycle"].includes(job.name))).toEqual([
      { name: "funnel-digest", intervalMinutes: 10080, lastSuccess: null, ageMinutes: null, state: "never" },
      { name: "provider-balance", intervalMinutes: 10, lastSuccess: null, ageMinutes: null, state: "never" },
      { name: "lifecycle", intervalMinutes: 10, lastSuccess: null, ageMinutes: null, state: "never" },
    ]);
    expect(CRON_JOBS.find((job) => job.name === "billing-reconcile")).toMatchObject({
      intervalMinutes: billingReconcile.everyMinutes,
      every: billingReconcile.everyMinutes,
    });
    for (const job of CRON_JOBS as readonly CronJobDefinition[]) {
      expect(cronJobProblems(job)).toEqual([]);
    }
    expect(new Set(CRON_JOBS.map((job) => job.name)).size).toBe(CRON_JOBS.length);
  });

  it("accepts one schedule and a run, and names each problem", () => {
    const run = async () => undefined;
    expect(cronJobProblems({ name: "tick-job", intervalMinutes: 10, every: 10, run })).toEqual([]);
    expect(cronJobProblems({ name: "daily", intervalMinutes: 1440, dailyAtUtc: "09:15" })).toEqual([]);
    expect(cronJobProblems({ name: "weekly", intervalMinutes: 10080, weeklyAt: { weekday: 1, atUtc: "13:00" } })).toEqual([]);
    expect(cronJobProblems({ name: "Bad Name", intervalMinutes: 0, every: 5, dailyAtUtc: "24:00" })).toEqual([
      "name must be lower case letters, digits and hyphens",
      "intervalMinutes must be a positive whole number",
      "set at most one of every, dailyAtUtc and weeklyAt",
      "dailyAtUtc must be HH:MM",
    ]);
    expect(cronJobProblems({ name: "x", intervalMinutes: 5, every: 2.5 })).toEqual([
      "every must be a positive whole number of minutes",
    ]);
    expect(cronJobProblems({ name: "x", intervalMinutes: 5, weeklyAt: { weekday: 0, atUtc: "7:00" } })).toEqual([
      "weeklyAt.atUtc must be HH:MM",
    ]);
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
    expect(cronFreshness(successes, NOW, BASE_JOBS).map((s) => s.state)).toEqual(["fresh", "fresh"]);
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
