/**
 * A sign in that just verified the account's email: the email was confirmed
 * within FRESH_VERIFICATION_MS. The auth callback sends those to /welcome.
 * Password recovery and later magic links do not change the confirmation
 * time, so they never see the welcome page.
 */
export const FRESH_VERIFICATION_MS = 15 * 60 * 1000;

export function isFreshVerification(
  user: { email_confirmed_at?: string | null } | null | undefined,
  now: number = Date.now(),
): boolean {
  const confirmed = user?.email_confirmed_at ? Date.parse(user.email_confirmed_at) : Number.NaN;
  return Number.isFinite(confirmed) && now - confirmed >= 0 && now - confirmed <= FRESH_VERIFICATION_MS;
}

/** The welcome page, carrying the page the user was heading to. */
export function welcomePath(next: string): string {
  return next === "/app" ? "/welcome" : `/welcome?next=${encodeURIComponent(next)}`;
}
