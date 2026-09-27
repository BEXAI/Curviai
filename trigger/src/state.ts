/**
 * Pack job state machine and credit ledger plan as pure code
 * (CURVI_BUILD_PLAN.md section 4.4). No Trigger.dev imports here: the task
 * files are thin wrappers and this module is unit tested exhaustively.
 *
 * States move in order queued, analyzing, planning, generating, qc,
 * packaging, done, with a qc to generating retry loop. Any non terminal
 * state may end in failed or canceled.
 *
 * Ledger rules: credits are reserved when the job enters queued, charged per
 * passing asset during qc, and released for failed shots and on job failure.
 */

export const JOB_STATES = [
  "queued",
  "analyzing",
  "planning",
  "generating",
  "qc",
  "packaging",
  "done",
  "failed",
  "canceled",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const JOB_EVENTS = [
  "start_analysis",
  "analysis_done",
  "plan_ready",
  "shots_generated",
  "qc_retry",
  "qc_done",
  "packaged",
  "fail",
  "cancel",
] as const;
export type JobEvent = (typeof JOB_EVENTS)[number];

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set(["done", "failed", "canceled"]);

/** Forward transitions in plan 4.4 order, including the qc retry loop. */
const FORWARD: Partial<Record<JobState, Partial<Record<JobEvent, JobState>>>> = {
  queued: { start_analysis: "analyzing" },
  analyzing: { analysis_done: "planning" },
  planning: { plan_ready: "generating" },
  generating: { shots_generated: "qc" },
  qc: { qc_retry: "generating", qc_done: "packaging" },
  packaging: { packaged: "done" },
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly state: JobState,
    readonly event: JobEvent,
  ) {
    super(`Illegal transition: event "${event}" is not allowed in state "${state}"`);
    this.name = "IllegalTransitionError";
  }
}

/**
 * Reducer over the job state machine. Returns the next state for a legal
 * transition and throws IllegalTransitionError otherwise. fail and cancel
 * are legal from every non terminal state; terminal states accept nothing.
 */
export function transition(state: JobState, event: JobEvent): JobState {
  if (TERMINAL_STATES.has(state)) {
    throw new IllegalTransitionError(state, event);
  }
  if (event === "fail") {
    return "failed";
  }
  if (event === "cancel") {
    return "canceled";
  }
  const next = FORWARD[state]?.[event];
  if (!next) {
    throw new IllegalTransitionError(state, event);
  }
  return next;
}

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Reasons align with the credit_ledger reason column in @curvi/db. */
export type LedgerReason = "reserve" | "charge" | "release";

export interface LedgerAction {
  reason: LedgerReason;
  /** Always a positive credit amount; the reason carries the direction. */
  credits: number;
  /** Shot or asset the action refers to, when it refers to one. */
  ref?: string;
  note: string;
}

/**
 * Tracks the credit consequences of one job run. Pure bookkeeping: callers
 * apply the returned LedgerAction rows to the real credit ledger.
 *
 * Invariant: reserved = charged + released + outstanding.
 */
export class JobLedgerPlan {
  private reservedCredits = 0;
  private chargedCredits = 0;
  private releasedCredits = 0;
  private hasReserved = false;

  get reserved(): number {
    return this.reservedCredits;
  }

  get charged(): number {
    return this.chargedCredits;
  }

  get released(): number {
    return this.releasedCredits;
  }

  /** Credits still held by the reservation, not yet charged or released. */
  get outstanding(): number {
    return this.reservedCredits - this.chargedCredits - this.releasedCredits;
  }

  /** Credits are reserved once, when the job enters queued. */
  reserveOnQueue(credits: number): LedgerAction {
    if (this.hasReserved) {
      throw new Error("Credits were already reserved for this job");
    }
    if (!(credits > 0)) {
      throw new Error(`Reserve amount must be positive, got ${credits}`);
    }
    this.hasReserved = true;
    this.reservedCredits = credits;
    return { reason: "reserve", credits, note: "reserved on entering queued" };
  }

  /** Charged per passing asset while the job is in qc. */
  chargeForPassingAsset(assetRef: string, credits: number): LedgerAction {
    this.assertHolds(credits, "charge");
    this.chargedCredits += credits;
    return { reason: "charge", credits, ref: assetRef, note: "asset passed qc" };
  }

  /** Released when a shot exhausts retries and goes to needs review. */
  releaseForFailedShot(shotRef: string, credits: number): LedgerAction {
    this.assertHolds(credits, "release");
    this.releasedCredits += credits;
    return { reason: "release", credits, ref: shotRef, note: "shot needs review" };
  }

  /** Releases everything still outstanding when the job fails or is canceled. */
  releaseRemainderOnFailure(cause: "failed" | "canceled" = "failed"): LedgerAction | null {
    const remainder = this.outstanding;
    if (remainder <= 0) {
      return null;
    }
    this.releasedCredits += remainder;
    return { reason: "release", credits: remainder, note: `job ${cause}, reservation returned` };
  }

  /** Releases the unused part of the reservation after a successful run. */
  releaseUnusedOnCompletion(): LedgerAction | null {
    const remainder = this.outstanding;
    if (remainder <= 0) {
      return null;
    }
    this.releasedCredits += remainder;
    return { reason: "release", credits: remainder, note: "unused reservation returned on completion" };
  }

  private assertHolds(credits: number, verb: string): void {
    if (!this.hasReserved) {
      throw new Error(`Cannot ${verb} before reserving`);
    }
    if (!(credits >= 0)) {
      throw new Error(`Cannot ${verb} a negative amount: ${credits}`);
    }
    if (credits > this.outstanding) {
      throw new Error(
        `Cannot ${verb} ${credits} credits: only ${this.outstanding} of the reservation is outstanding`,
      );
    }
  }
}
