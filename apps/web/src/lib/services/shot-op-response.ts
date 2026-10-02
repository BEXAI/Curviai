/**
 * HTTP answers for the pack operations (cancel, retry a shot, add a photo),
 * shared by their routes so each refusal always maps to the same status.
 */

import { NextResponse } from "next/server";
import { refusalInit } from "./workspace-response";
import type { CancelJobResult, ShotOpRejection, ShotOpResult } from "./types";

const SHOT_OP_STATUS: Record<ShotOpRejection, number> = {
  not_found: 404,
  role_forbidden: 403,
  foreign_key: 403,
  not_ready: 409,
  not_retryable: 409,
  channel_full: 409,
  conflict: 409,
  insufficient_credits: 402,
  credit_budget_exceeded: 409,
  unavailable: 503,
  // The added photo failed the server side upload check (not a photo, over
  // the pixel cap, unreadable).
  invalid_upload: 422,
  demo: 400,
};

/** Shot ids the planners and the plan rows write: letters, digits and _ : . - */
export function isShotId(value: string): boolean {
  return /^[A-Za-z0-9_:.-]{1,120}$/.test(value);
}

export function shotOpResponse(result: ShotOpResult): NextResponse {
  if (result.outcome === "started") {
    return NextResponse.json({ job: result.job, creditsHeld: result.creditsHeld }, { status: 202 });
  }
  return NextResponse.json({ error: result.message, reason: result.reason }, refusalInit(SHOT_OP_STATUS[result.reason]));
}

export function cancelResponse(result: CancelJobResult): NextResponse {
  switch (result.outcome) {
    case "canceled":
    case "stopped":
      return NextResponse.json({
        job: result.job,
        outcome: result.outcome,
        refundedCredits: result.refundedCredits,
        notice: result.notice,
      });
    case "finished":
      return NextResponse.json(
        { job: result.job, outcome: result.outcome, error: result.notice, reason: "finished" },
        { status: 409 },
      );
    case "rejected": {
      const status = result.reason === "not_found" ? 404 : result.reason === "role_forbidden" ? 403 : 503;
      return NextResponse.json({ error: result.message, reason: result.reason }, refusalInit(status));
    }
  }
}
