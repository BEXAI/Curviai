/** Fixed messages only. Provider messages can contain account or server details. */
export const AUTH_FAILURE_COPY = {
  invalid_credentials: "That email and password do not match. Try again or reset your password.",
  user_already_exists: "An account with this email already exists. Log in instead.",
  email_exists: "An account with this email already exists. Log in instead.",
  email_not_confirmed: "Confirm your email before you log in. You can send the link again below.",
  over_email_send_rate_limit: "We sent several links already. Wait a minute, then try again.",
  over_request_rate_limit: "Please wait a minute, then try again.",
  weak_password: "Choose a stronger password with at least eight characters.",
  same_password: "Choose a password you have not used for this account.",
  captcha_failed: "We could not check that you are a person. Please try again.",
  otp_expired: "That sign in link has expired or was already used. Send the link again below.",
} as const;

export function authFailureMessage(code: unknown): string {
  if (typeof code === "string" && Object.hasOwn(AUTH_FAILURE_COPY, code)) {
    return AUTH_FAILURE_COPY[code as keyof typeof AUTH_FAILURE_COPY];
  }
  // Only log a bounded code, never the provider message or account details.
  console.warn("auth request refused", typeof code === "string" && /^[a-z_]{1,80}$/.test(code) ? code : "unknown");
  return "Something went wrong. Please try again.";
}
