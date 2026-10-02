import { describe, expect, it } from "vitest";
import { errorReportRetentionDays, errorReporting, healthLimits } from "./index";

// docs/phases/PHASE_20.md P20-13 and P20-15: the error reporting caps and
// the health limits live in the seed (CLAUDE.md rule 2).

/** Sentry's free Developer plan: 5k errors a month (docs/verification.md). */
const DEVELOPER_PLAN_ERRORS_PER_MONTH = 5_000;

describe("errorReporting (P20-13)", () => {
  it("seeds the plan's caps", () => {
    expect(errorReporting).toEqual({ maxSameErrorPerHour: 20, maxEventsPerHour: 60, maxEventsPerDay: 150 });
  });

  it("keeps a 31 day month at the daily cap under the free plan's monthly errors", () => {
    expect(errorReporting.maxEventsPerDay * 31).toBeLessThan(DEVELOPER_PLAN_ERRORS_PER_MONTH);
  });

  it("orders the caps: one error below the hourly cap, the hourly cap below the daily cap", () => {
    for (const value of Object.values(errorReporting)) {
      expect(Number.isInteger(value) && value > 0).toBe(true);
    }
    expect(errorReporting.maxSameErrorPerHour).toBeLessThan(errorReporting.maxEventsPerHour);
    expect(errorReporting.maxEventsPerHour).toBeLessThanOrEqual(errorReporting.maxEventsPerDay);
  });
});

describe("healthLimits (P20-15)", () => {
  it("seeds the Free plan's 500 MB database and the warning ratios", () => {
    expect(healthLimits).toEqual({
      dbSizeLimitBytes: 500 * 1024 * 1024,
      dbSizeHighRatio: 0.7,
      memoryStartRatio: 0.6,
    });
  });

  it("keeps every ratio a share between 0 and 1", () => {
    for (const ratio of [healthLimits.dbSizeHighRatio, healthLimits.memoryStartRatio]) {
      expect(ratio).toBeGreaterThan(0);
      expect(ratio).toBeLessThan(1);
    }
  });
});

describe("errorReportRetentionDays (P20-23)", () => {
  it("is the Developer plan's 30 day lookback", () => {
    expect(errorReportRetentionDays).toBe(30);
  });
});
