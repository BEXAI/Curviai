import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { longDate, shortDate } from "./dates";

// 02:00 UTC on October 1 is still September 30 in Los Angeles.
const EARLY_UTC = "2026-10-01T02:00:00Z";

describe("longDate and shortDate", () => {
  let tz: string | undefined;

  beforeEach(() => {
    tz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
  });

  afterEach(() => {
    if (tz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = tz;
    }
  });

  it("shows the UTC day whatever the local time zone", () => {
    expect(longDate(EARLY_UTC)).toBe("October 1, 2026");
    expect(shortDate(EARLY_UTC)).toBe("Oct 1, 2026");
    expect(longDate(new Date(EARLY_UTC))).toBe("October 1, 2026");
    expect(shortDate(new Date(EARLY_UTC))).toBe("Oct 1, 2026");
  });

  it("gives null for a value that is not a date", () => {
    expect(longDate("not a date")).toBeNull();
    expect(shortDate("")).toBeNull();
    expect(longDate(new Date(Number.NaN))).toBeNull();
  });
});
