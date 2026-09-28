/**
 * Polling policy for the progress board (Update.md 6.4), kept pure so it is
 * unit testable. The board reports what one poll returned and gets back
 * whether to poll again and after how long, or why to stop.
 */

export const POLL_MS = 2000;
export const MAX_BACKOFF_MS = 30_000;
/** Consecutive failed polls (5xx, 429 or network) before the board gives up
 * and offers Try again. */
export const MAX_POLL_FAILURES = 5;

const TERMINAL = new Set(["done", "failed", "canceled"]);

export function isTerminalJobStatus(status: string): boolean {
  return TERMINAL.has(status);
}

export type PollResult =
  | { kind: "job"; status: string }
  | { kind: "http"; status: number }
  | { kind: "network" };

export type PollStopReason = "terminal" | "not_found" | "signed_out" | "forbidden" | "gave_up";

export type PollDecision =
  | { action: "continue"; delayMs: number; failures: number }
  | { action: "stop"; reason: PollStopReason; failures: number };

/** Delay before the next poll after `failures` consecutive failures. */
export function backoffMs(failures: number): number {
  if (failures <= 0) {
    return POLL_MS;
  }
  return Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS);
}

export function nextPoll(result: PollResult, failures: number): PollDecision {
  if (result.kind === "job") {
    return isTerminalJobStatus(result.status)
      ? { action: "stop", reason: "terminal", failures: 0 }
      : { action: "continue", delayMs: POLL_MS, failures: 0 };
  }
  if (result.kind === "http") {
    if (result.status === 401) {
      return { action: "stop", reason: "signed_out", failures };
    }
    if (result.status === 403) {
      return { action: "stop", reason: "forbidden", failures };
    }
    if (result.status === 404) {
      return { action: "stop", reason: "not_found", failures };
    }
  }
  // 5xx, 429, an unexpected body or a network error: back off, then give up.
  const next = failures + 1;
  if (next >= MAX_POLL_FAILURES) {
    return { action: "stop", reason: "gave_up", failures: next };
  }
  return { action: "continue", delayMs: backoffMs(next), failures: next };
}

export interface PollStopCopy {
  title: string;
  body: string;
}

/** What the board says when polling stops for a reason other than the job
 * finishing. */
export function pollStopCopy(reason: Exclude<PollStopReason, "terminal">): PollStopCopy {
  switch (reason) {
    case "signed_out":
      return { title: "Your session ended", body: "Sign in again to see this pack." };
    case "forbidden":
      return { title: "You do not have access to this pack", body: "It belongs to a workspace you are not a member of." };
    case "not_found":
      return {
        title: "We could not find this pack",
        body: "It does not exist, or it belongs to another workspace.",
      };
    case "gave_up":
      return {
        title: "We lost touch with the server",
        body: "Your pack keeps running while this page is away. Try again in a moment.",
      };
  }
}
