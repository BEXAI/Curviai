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
