"use client";

import { useState } from "react";
import { Button } from "@curvi/ui";
import { runAuthCall, trackAuthError } from "@/lib/auth-call";
import { GOOGLE_SIGN_IN_LABEL, googleOAuthCredentials } from "@/lib/google-sign-in";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export interface GoogleSignInButtonProps {
  mode: "signup" | "login";
  /** The /auth/callback URL to return to, built at click time so it carries
   * the page's current next path and attribution. */
  redirectTo: () => string;
}

/** Google's "G" mark, as Google's sign in branding asks for. */
function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" className="h-4 w-4 shrink-0">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/**
 * "Continue with Google" (docs/phases/PHASE_18.md P18-13). Starts
 * Supabase's OAuth flow; on success the browser leaves for Google, so the
 * button stays busy. A failure to start shows the auth call's plain message
 * and frees the button.
 */
export function GoogleSignInButton({ mode, redirectTo }: GoogleSignInButtonProps) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function start() {
    const supabase = createSupabaseBrowserClient();
    if (!supabase) {
      setMessage("Sign in is not available right now. Please try again later.");
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await runAuthCall(() => supabase.auth.signInWithOAuth(googleOAuthCredentials(redirectTo())));
    if (!result.ok) {
      setBusy(false);
      setMessage(result.message);
      trackAuthError(mode, result.kind);
    }
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        className="w-full gap-2"
        disabled={busy}
        onClick={start}
        data-testid="google-sign-in"
      >
        <GoogleMark />
        {busy ? "Opening Google" : GOOGLE_SIGN_IN_LABEL}
      </Button>
      {message ? (
        <p role="alert" className="text-sm text-red-600">
          {message}
        </p>
      ) : null}
    </div>
  );
}
