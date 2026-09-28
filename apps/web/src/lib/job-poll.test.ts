import { describe, expect, it } from "vitest";
import { MAX_BACKOFF_MS, MAX_POLL_FAILURES, POLL_MS, backoffMs, nextPoll, pollStopCopy } from "./job-poll";

describe("nextPoll (Update.md 6.4)", () => {
  it("keeps polling a running job every two seconds and resets failures", () => {
    expect(nextPoll({ kind: "job", status: "generating" }, 3)).toEqual({
      action: "continue",
      delayMs: POLL_MS,
      failures: 0,
    });
  });

  it("stops at a terminal state", () => {
    for (const status of ["done", "failed", "canceled"]) {
      expect(nextPoll({ kind: "job", status }, 0)).toMatchObject({ action: "stop", reason: "terminal" });
    }
  });

  it("stops at once on 401, 403 and 404 with a reason the board can explain", () => {
    expect(nextPoll({ kind: "http", status: 401 }, 0)).toMatchObject({ action: "stop", reason: "signed_out" });
    expect(nextPoll({ kind: "http", status: 403 }, 0)).toMatchObject({ action: "stop", reason: "forbidden" });
    expect(nextPoll({ kind: "http", status: 404 }, 0)).toMatchObject({ action: "stop", reason: "not_found" });
  });

  it("backs off on server and network errors, then gives up", () => {
    let failures = 0;
    const delays: number[] = [];
    for (let i = 0; i < MAX_POLL_FAILURES; i += 1) {
      const decision = nextPoll(i % 2 === 0 ? { kind: "http", status: 500 } : { kind: "network" }, failures);
      failures = decision.failures;
      if (decision.action === "continue") {
        delays.push(decision.delayMs);
      } else {
        expect(decision.reason).toBe("gave_up");
        expect(i).toBe(MAX_POLL_FAILURES - 1);
      }
    }
    expect(delays).toHaveLength(MAX_POLL_FAILURES - 1);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });

  it("a good poll after errors resets the count", () => {
    const failed = nextPoll({ kind: "http", status: 503 }, 0);
    expect(failed.failures).toBe(1);
    expect(nextPoll({ kind: "job", status: "qc" }, failed.failures).failures).toBe(0);
  });

  it("caps the backoff", () => {
    expect(backoffMs(0)).toBe(POLL_MS);
    expect(backoffMs(20)).toBe(MAX_BACKOFF_MS);
  });
});

describe("pollStopCopy", () => {
  it("has plain copy for every stop reason", () => {
    for (const reason of ["signed_out", "forbidden", "not_found", "gave_up"] as const) {
      const copy = pollStopCopy(reason);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body).not.toMatch(/[–—]| - /);
    }
    expect(pollStopCopy("signed_out").body).toContain("Sign in");
  });
});
