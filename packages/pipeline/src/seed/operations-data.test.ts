import { describe, expect, it } from "vitest";
import * as seed from "./index";
import { backup, restoreDrill } from "./operations";

// docs/phases/PHASE_20.md P20-10 and P20-11, decisions 11 and 12: the backup
// retention, the freshness line and the drill's age limit are seed values.

function positiveWhole(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

describe("backup policy", () => {
  it("keeps daily copies 35 days, monthly copies 180 days and locks the newest 7 days (decision 12)", () => {
    expect(backup).toMatchObject({ dailyKeepDays: 35, monthlyKeepDays: 180, lockDays: 7 });
    for (const value of Object.values(backup)) {
      expect(positiveWhole(value)).toBe(true);
    }
  });

  it("locks fewer days than the lifecycle keeps, and keeps monthly copies longest", () => {
    // A lock overrides the lifecycle (Cloudflare R2 bucket locks), so a lock
    // as long as the daily window would keep every daily copy forever.
    expect(backup.lockDays).toBeLessThan(backup.dailyKeepDays);
    expect(backup.monthlyKeepDays).toBeGreaterThan(backup.dailyKeepDays);
  });

  it("calls a daily backup stale only after a full day and some slack", () => {
    expect(backup.maxAgeHours).toBeGreaterThan(24);
    expect(backup.maxAgeHours).toBeLessThan(48);
  });
});

describe("restore drill policy", () => {
  it("expects a drill about monthly and a recovery inside two hours", () => {
    expect(restoreDrill).toEqual({ maxAgeDays: 35, rtoTargetMinutes: 120 });
  });

  it("is exported from the seed index", () => {
    expect(seed.backup).toBe(backup);
    expect(seed.restoreDrill).toBe(restoreDrill);
  });
});
