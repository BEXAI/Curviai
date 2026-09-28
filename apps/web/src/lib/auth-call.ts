/**
 * Wraps a browser Supabase auth call so a form can never stay stuck in its
 * busy state (Update.md 6.11). supabase-js returns most failures as an error
 * value, but a thrown fetch, a blocked request or an unreachable auth server
 * can also reject. Both come back here as one result the form renders.
 */

export const AUTH_NETWORK_ERROR = "We could not reach the sign in service. Check your connection and try again.";

export const AUTH_GENERIC_ERROR = "Something went wrong. Please try again.";

export type AuthFormName = "signup" | "login" | "forgot_password" | "reset_password";

interface AuthErrorLike {
  message?: string;
  name?: string;
  status?: number;
}

export type AuthCallResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; kind: "network" | "rejected" };

/** supabase-js reports an unreachable or overloaded auth server (no
 * response, or a 502, 503 or 504) as AuthRetryableFetchError. */
export function isNetworkAuthError(error: AuthErrorLike | null | undefined): boolean {
  return Boolean(error && (error.name === "AuthRetryableFetchError" || error.status === 0));
}

export async function runAuthCall<T extends { error: AuthErrorLike | null }>(
  call: () => Promise<T>,
): Promise<AuthCallResult<T>> {
  let value: T;
  try {
    value = await call();
  } catch {
    return { ok: false, message: AUTH_NETWORK_ERROR, kind: "network" };
  }
  if (value.error) {
    if (isNetworkAuthError(value.error)) {
      return { ok: false, message: AUTH_NETWORK_ERROR, kind: "network" };
    }
    const message = value.error.message?.trim();
    return { ok: false, message: message ? message : AUTH_GENERIC_ERROR, kind: "rejected" };
  }
  return { ok: true, value };
}

/**
 * Records auth_error in PostHog when analytics is configured and loaded.
 * Never throws and never blocks the form.
 */
export function trackAuthError(form: AuthFormName, kind: "network" | "rejected"): void {
  if (typeof window === "undefined" || !process.env.NEXT_PUBLIC_POSTHOG_KEY) {
    return;
  }
  void import("posthog-js")
    .then(({ default: posthog }) => {
      if (posthog.__loaded) {
        posthog.capture("auth_error", { form, kind });
      }
    })
    .catch(() => undefined);
}
