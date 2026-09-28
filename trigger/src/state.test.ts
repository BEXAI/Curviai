import { describe, expect, it } from "vitest";
import {
  IllegalTransitionError,
  JOB_EVENTS,
  JOB_STATES,
  JobLedgerPlan,
  TERMINAL_STATES,
  isTerminal,
  transition,
  type JobEvent,
  type JobState,
} from "./state";

const FORWARD_TRANSITIONS: Array<[JobState, JobEvent, JobState]> = [
  ["queued", "start_analysis", "analyzing"],
  ["analyzing", "analysis_done", "planning"],
  ["planning", "plan_ready", "generating"],
  ["generating", "shots_generated", "qc"],
  ["qc", "qc_retry", "generating"],
  ["qc", "qc_done", "packaging"],
  ["packaging", "packaged", "done"],
];

const NON_TERMINAL_STATES = JOB_STATES.filter((s) => !TERMINAL_STATES.has(s));

function legalNext(state: JobState, event: JobEvent): JobState | null {
  if (TERMINAL_STATES.has(state)) {
    return null;
  }
  if (event === "fail") {
    return "failed";
  }
  if (event === "cancel") {
    return "canceled";
  }
  const row = FORWARD_TRANSITIONS.find(([s, e]) => s === state && e === event);
  return row ? row[2] : null;
}

describe("transition", () => {
  it("follows the plan 4.4 order through every forward transition", () => {
    for (const [state, event, next] of FORWARD_TRANSITIONS) {
      expect(transition(state, event)).toBe(next);
    }
  });

  it("allows fail and cancel from every non terminal state", () => {
    for (const state of NON_TERMINAL_STATES) {
      expect(transition(state, "fail")).toBe("failed");
      expect(transition(state, "cancel")).toBe("canceled");
    }
  });

  it("rejects every illegal state and event combination", () => {
    let legalCount = 0;
    let illegalCount = 0;
    for (const state of JOB_STATES) {
      for (const event of JOB_EVENTS) {
        const expected = legalNext(state, event);
        if (expected) {
          legalCount += 1;
          expect(transition(state, event)).toBe(expected);
        } else {
          illegalCount += 1;
          expect(() => transition(state, event)).toThrowError(IllegalTransitionError);
        }
      }
    }
    // 7 forward transitions plus fail and cancel from 6 non terminal states.
    expect(legalCount).toBe(7 + NON_TERMINAL_STATES.length * 2);
    expect(legalCount + illegalCount).toBe(JOB_STATES.length * JOB_EVENTS.length);
  });

  it("rejects everything from terminal states, including fail and cancel", () => {
    for (const state of ["done", "failed", "canceled"] as const) {
      expect(isTerminal(state)).toBe(true);
      for (const event of JOB_EVENTS) {
        expect(() => transition(state, event)).toThrowError(IllegalTransitionError);
      }
    }
  });

  it("carries the offending state and event on the error", () => {
    try {
      transition("queued", "packaged");
      expect.unreachable("transition should have thrown");
    } catch (err) {
      const e = err as IllegalTransitionError;
      expect(e.state).toBe("queued");
      expect(e.event).toBe("packaged");
    }
  });
});

describe("JobLedgerPlan", () => {
  it("reserves credits once when the job enters queued", () => {
    const plan = new JobLedgerPlan();
    const action = plan.reserveOnQueue(20);
    expect(action).toMatchObject({ reason: "reserve", credits: 20 });
    expect(plan.reserved).toBe(20);
    expect(plan.outstanding).toBe(20);
    expect(() => plan.reserveOnQueue(5)).toThrowError(/already reserved/);
  });

  it("rejects a non positive reservation", () => {
    expect(() => new JobLedgerPlan().reserveOnQueue(0)).toThrowError(/positive/);
    expect(() => new JobLedgerPlan().reserveOnQueue(-3)).toThrowError(/positive/);
  });

  it("charges per passing asset during qc and tracks the reference", () => {
    const plan = new JobLedgerPlan();
    plan.reserveOnQueue(10);
    const action = plan.chargeForPassingAsset("s01_amazon_main", 0.5);
    expect(action).toMatchObject({ reason: "charge", credits: 0.5, ref: "s01_amazon_main" });
    expect(plan.charged).toBe(0.5);
    expect(plan.outstanding).toBe(9.5);
  });

  it("refuses to charge before reserving or beyond the reservation", () => {
    const empty = new JobLedgerPlan();
    expect(() => empty.chargeForPassingAsset("a", 1)).toThrowError(/before reserving/);
    const plan = new JobLedgerPlan();
    plan.reserveOnQueue(2);
    expect(() => plan.chargeForPassingAsset("a", 3)).toThrowError(/outstanding/);
  });

  it("releases credits for a failed shot", () => {
    const plan = new JobLedgerPlan();
    plan.reserveOnQueue(10);
    const action = plan.releaseForFailedShot("s05_lifestyle", 1);
    expect(action).toMatchObject({ reason: "release", credits: 1, ref: "s05_lifestyle" });
    expect(plan.released).toBe(1);
    expect(plan.outstanding).toBe(9);
    expect(() => plan.releaseForFailedShot("s06", 100)).toThrowError(/outstanding/);
  });

  it("releases a passing shot the packager did not deliver, with the reason", () => {
    const plan = new JobLedgerPlan();
    plan.reserveOnQueue(10);
    const action = plan.releaseForUndeliveredShot("sec9", 0.5, "channel image limit: amazon.secondary takes at most 8 images");
    expect(action).toMatchObject({ reason: "release", credits: 0.5, ref: "sec9" });
    expect(action.note).toBe("shot not delivered: channel image limit: amazon.secondary takes at most 8 images");
    expect(plan.released).toBe(0.5);
    expect(() => plan.releaseForUndeliveredShot("sec10", 100, "x")).toThrowError(/outstanding/);
  });

  it("releases the whole remainder on job failure", () => {
    const plan = new JobLedgerPlan();
    plan.reserveOnQueue(10);
    plan.chargeForPassingAsset("a", 3);
    const action = plan.releaseRemainderOnFailure("failed");
    expect(action).toMatchObject({ reason: "release", credits: 7 });
    expect(action?.note).toContain("failed");
    expect(plan.outstanding).toBe(0);
    expect(plan.releaseRemainderOnFailure("failed")).toBeNull();
  });

  it("marks a canceled release distinctly", () => {
    const plan = new JobLedgerPlan();
    plan.reserveOnQueue(4);
    const action = plan.releaseRemainderOnFailure("canceled");
    expect(action?.note).toContain("canceled");
  });

  it("returns the unused remainder on completion and nothing when fully used", () => {
    const plan = new JobLedgerPlan();
    plan.reserveOnQueue(5);
    plan.chargeForPassingAsset("a", 2);
    plan.releaseForFailedShot("b", 1);
    const leftover = plan.releaseUnusedOnCompletion();
    expect(leftover).toMatchObject({ reason: "release", credits: 2 });
    expect(plan.releaseUnusedOnCompletion()).toBeNull();

    const exact = new JobLedgerPlan();
    exact.reserveOnQueue(2);
    exact.chargeForPassingAsset("a", 2);
    expect(exact.releaseUnusedOnCompletion()).toBeNull();
  });

  it("holds the invariant reserved equals charged plus released plus outstanding", () => {
    const plan = new JobLedgerPlan();
    plan.reserveOnQueue(12);
    plan.chargeForPassingAsset("a", 3);
    plan.releaseForFailedShot("b", 2);
    plan.chargeForPassingAsset("c", 1);
    expect(plan.reserved).toBe(plan.charged + plan.released + plan.outstanding);
    plan.releaseRemainderOnFailure("failed");
    expect(plan.reserved).toBe(plan.charged + plan.released);
    expect(plan.outstanding).toBe(0);
  });
});
