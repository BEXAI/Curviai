import type { ErrorEvent } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";
import { errorReporting } from "@curvi/pipeline/seed";
import { ErrorEventLimiter, eventFingerprint, normalizeErrorText } from "./limits";

// docs/phases/PHASE_20.md P20-13: the repeat limiter and the hourly and
// daily caps keep the free 5k errors a month from running out.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function clock(start = Date.parse("2026-10-01T00:00:00Z")): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return { now: () => at, advance: (ms) => (at += ms) };
}

function sendMany(limiter: ErrorEventLimiter, fingerprint: (i: number) => string, count: number): number {
  let sent = 0;
  for (let i = 0; i < count; i += 1) {
    if (limiter.check(fingerprint(i)) === "send") sent += 1;
  }
  return sent;
}

describe("ErrorEventLimiter", () => {
  it("sends the same error at most maxSameErrorPerHour times in an hour", () => {
    const time = clock();
    const limiter = new ErrorEventLimiter(errorReporting, time.now);
    expect(sendMany(limiter, () => "same", 25)).toBe(errorReporting.maxSameErrorPerHour);
    expect(limiter.check("same")).toBe("same_error_limit");
    // Another error still goes out.
    expect(limiter.check("other")).toBe("send");
    // The window slides: an hour after the first ones, it is sent again.
    time.advance(HOUR + 1);
    expect(limiter.check("same")).toBe("send");
    expect(limiter.droppedCounts().same_error_limit).toBe(6);
  });

  it("caps every error together per hour", () => {
    const time = clock();
    const limiter = new ErrorEventLimiter(errorReporting, time.now);
    expect(sendMany(limiter, (i) => `error-${i}`, 100)).toBe(errorReporting.maxEventsPerHour);
    expect(limiter.check("fresh")).toBe("hourly_limit");
    time.advance(HOUR + 1);
    expect(limiter.check("fresh")).toBe("send");
  });

  it("caps every error together per day, even spread over the hours", () => {
    const time = clock();
    const limiter = new ErrorEventLimiter(errorReporting, time.now);
    let sent = 0;
    for (let hour = 0; hour < 24; hour += 1) {
      sent += sendMany(limiter, (i) => `h${hour}-e${i}`, errorReporting.maxEventsPerHour);
      time.advance(HOUR);
    }
    expect(sent).toBe(errorReporting.maxEventsPerDay);
    expect(limiter.droppedCounts().daily_limit).toBeGreaterThan(0);
    // 24 hours after the first event, room opens up again.
    time.advance(MINUTE);
    expect(limiter.check("next-day")).toBe("send");
  });

  it("keeps a month at the daily cap under the free plan", () => {
    const time = clock();
    const limiter = new ErrorEventLimiter(errorReporting, time.now);
    let sent = 0;
    for (let hour = 0; hour < 31 * 24; hour += 1) {
      sent += sendMany(limiter, (i) => `m${hour}-${i}`, 100);
      time.advance(HOUR);
    }
    expect(sent).toBeLessThanOrEqual(31 * errorReporting.maxEventsPerDay);
    expect(sent).toBeLessThan(5_000);
  });
});

describe("eventFingerprint", () => {
  it("counts the same exception with different ids as one error", () => {
    const at = (id: string, n: number): ErrorEvent =>
      ({
        exception: {
          values: [
            {
              type: "Error",
              value: `job ${id} failed after ${n} ms`,
              stacktrace: { frames: [{ filename: "a.js", function: "outer" }, { module: "runner", function: "run" }] },
            },
          ],
        },
      }) as ErrorEvent;
    const a = eventFingerprint(at("3f2b8c1e-0a4d-4c7e-9b1a-2d3e4f5a6b7c", 12));
    const b = eventFingerprint(at("9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", 345));
    expect(a).toBe(b);
    expect(a).toContain("runner:run");
  });

  it("uses an explicit fingerprint, and the message otherwise", () => {
    expect(eventFingerprint({ fingerprint: ["founder-alert", "hard_stop", "2026-10-01"] } as ErrorEvent)).toBe(
      "fingerprint|founder-alert|hard_stop|2026-10-01",
    );
    expect(eventFingerprint({ fingerprint: ["{{ default }}", "x"], message: "m 1" } as ErrorEvent)).toBe(
      eventFingerprint({ message: "m 2" } as ErrorEvent),
    );
    expect(eventFingerprint({ message: "[jobs] job 12 failed", level: "error" } as ErrorEvent)).toBe(
      "message|error|[jobs] job <n> failed",
    );
  });
});

describe("normalizeErrorText", () => {
  it("takes out ids, hex and numbers and caps the length", () => {
    expect(normalizeErrorText("job 3f2b8c1e-0a4d-4c7e-9b1a-2d3e4f5a6b7c  hash deadbeefcafe took 1.5 s")).toBe(
      "job <id> hash <hex> took <n> s",
    );
    expect(normalizeErrorText("x".repeat(1000)).length).toBe(300);
  });
});
