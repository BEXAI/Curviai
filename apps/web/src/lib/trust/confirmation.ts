/**
 * The typed confirmation for account deletion. Client safe, so the form and
 * the server action share one definition.
 */

export const DELETE_CONFIRMATION_WORD = "DELETE";

export function isDeleteConfirmed(typed: unknown): boolean {
  return typeof typed === "string" && typed.trim().toUpperCase() === DELETE_CONFIRMATION_WORD;
}
