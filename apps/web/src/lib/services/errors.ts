/**
 * Service errors routes map to HTTP answers. Kept apart from db.ts, which
 * pulls in the database driver, so route handlers and their tests can share
 * them without loading (or mocking) the database layer.
 */

export const PROVISIONING_ERROR_MESSAGE = "We could not set up your workspace. Try again in a minute.";

/** A pack that arrives while this server drains for a restart or deploy
 * (the inline runner's InlineRunnerClosedError). Its hold is returned. */
export const RESTARTING_MESSAGE =
  "We are restarting for an update, so this pack did not start and no credits were used. Try again in a minute.";

/** createJob's web line for an underfunded workspace. An assistant gets the
 * neutral MCP copy instead (PHASE_19 "Neutral messages"), built from the
 * rejection's creditsNeeded and creditsAvailable. */
export const INSUFFICIENT_CREDITS_MESSAGE = "Not enough credits for this pack. Top up or pick fewer channels.";

/** createJob's line for a channel pick that plans nothing to charge. */
export const NO_BILLABLE_SHOTS_MESSAGE = "This set has nothing to make for the channels you picked. Pick a bigger set or add a marketplace.";

/** createJob's refusal of a hold above the request's cap (PHASE_19 P19-16).
 * Only assistants send a cap; they read MCP_COPY.overMaxCredits. */
export function overMaxCreditsRejection(
  creditsNeeded: number,
  maxCredits: number,
): { outcome: "rejected"; reason: "over_max_credits"; message: string; creditsNeeded: number; maxCredits: number } {
  return {
    outcome: "rejected",
    reason: "over_max_credits",
    message: `This pack needs ${creditsNeeded} credits, more than the ${maxCredits} allowed for it, so it was not started.`,
    creditsNeeded,
    maxCredits,
  };
}

/**
 * Provisioning the first workspace failed (a database error, not a signed
 * out user). Thrown instead of returning null, so a signup that could not be
 * set up surfaces as a retryable server error rather than a "Sign in" prompt
 * (Update.md 6.8). Routes map it to 503 with PROVISIONING_ERROR_MESSAGE.
 */
export class ProvisioningError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(PROVISIONING_ERROR_MESSAGE, options);
    this.name = "ProvisioningError";
  }
}
