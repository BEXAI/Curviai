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

/** The consent page ChatGPT's sign in waits on (PHASE_19 P19-09). Its
 * authorization request lasts 10 minutes, so a new account goes straight
 * back to it after the confirmation link, without the welcome page. */
export const CONSENT_PATH = "/oauth/consent";

/** True for a next path the welcome page must not stand in front of. */
export function skipsWelcome(next: string): boolean {
  return next === CONSENT_PATH || next.startsWith(`${CONSENT_PATH}?`);
}

/** The welcome page, carrying the page the user was heading to and the
 * answers a category or channel page preselected (P18-20). */
export function welcomePath(next: string, profile: { category?: string; channel?: string } = {}): string {
  const params = new URLSearchParams();
  if (next !== "/app") {
    params.set("next", next);
  }
  if (profile.category) {
    params.set("category", profile.category);
  }
  if (profile.channel) {
    params.set("channel", profile.channel);
  }
  const query = params.toString();
  return query ? `/welcome?${query}` : "/welcome";
}
