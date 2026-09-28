/**
 * Errors shared by the runner, the live generator and the output helpers.
 * Kept in their own module so the helpers can throw them without importing
 * the runner (which imports the helpers).
 */

/** Thrown by a shot generator that cannot honestly produce a shot, for
 * example a method live providers do not cover yet, a missing source photo
 * or a spend cap block. The shot goes to needs review and its credits are
 * released; nothing placeholder is ever delivered or charged. */
export class ShotUnavailableError extends Error {
  constructor(
    message: string,
    /** Provider spend already made for this attempt, so it stays on the books. */
    readonly costMicros = 0,
  ) {
    super(message);
    this.name = "ShotUnavailableError";
  }
}
