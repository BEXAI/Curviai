"use client";

import { useState } from "react";
import { AuthForm } from "@/components/marketing/auth-form";
import { ForgotPasswordForm } from "@/components/marketing/password-forms";
import { CONSENT_COPY } from "@/lib/mcp-auth/consent-copy";

/**
 * Sign in and sign up inside the ChatGPT connect flow (PHASE_19 P19-09,
 * "Sign up inside the flow"). Both forms stay on the consent page, so the
 * visitor never meets the marketing header and its pricing link, and both
 * come back here: after a password sign in at once, after signup through
 * the email confirmation link (/auth/callback sends a next under
 * /oauth/consent straight back, skipping /welcome). Signup is the same
 * clickwrap as on /signup, so the terms record and the free signup grant
 * work as on the web. "Forgot password?" asks for the reset email here too
 * and says to come back to this page, instead of leaving for
 * /forgot-password.
 */
export function ConsentSignIn({ next }: { next: string }) {
  const [mode, setMode] = useState<"login" | "signup" | "reset">("login");
  return (
    <div className="space-y-4" data-testid="consent-sign-in">
      <p className="text-sm text-ink-600">{CONSENT_COPY.signInLead}</p>
      <div className="flex gap-2" role="group" aria-label="Log in or create an account">
        {(
          [
            ["login", CONSENT_COPY.logInTab],
            ["signup", CONSENT_COPY.signUpTab],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
            className={
              "rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors " +
              (mode === value ? "bg-ink-900 text-white" : "text-ink-600 hover:bg-ink-100 hover:text-ink-900")
            }
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "reset" ? (
        <ForgotPasswordForm onLogIn={() => setMode("login")} sentNote={CONSENT_COPY.resetSentNote} />
      ) : (
        <AuthForm
          key={mode}
          mode={mode}
          next={next}
          onSwitchMode={setMode}
          onForgotPassword={() => setMode("reset")}
          signupLabel={CONSENT_COPY.signUpButton}
          sentMessage={CONSENT_COPY.signUpSent}
          source="chatgpt"
        />
      )}
    </div>
  );
}
