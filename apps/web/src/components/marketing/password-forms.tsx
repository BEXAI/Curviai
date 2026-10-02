"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@curvi/ui";
import { AUTH_NETWORK_ERROR, isNetworkAuthError, runAuthCall, trackAuthError } from "@/lib/auth-call";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Turnstile, turnstileEnabled } from "./turnstile";

type Status = "idle" | "busy" | "sent" | "error";

/** Requests a password recovery email through Supabase auth. Inside the
 * ChatGPT connect flow (PHASE_19 P19-09) onLogIn switches back to the log in
 * form in place and sentNote says to come back to the page, so the visitor
 * never leaves the consent page or meets the marketing header. */
export function ForgotPasswordForm({ onLogIn, sentNote }: { onLogIn?: () => void; sentNote?: string } = {}) {
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaReset, setCaptchaReset] = useState(0);
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = createSupabaseBrowserClient();
    if (!supabase) {
      setStatus("error");
      setMessage("Password reset is not available right now. Please try again later.");
      return;
    }
    setStatus("busy");
    setMessage(null);
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent("/reset-password")}`;
    const result = await runAuthCall(() => supabase.auth.resetPasswordForEmail(email, { redirectTo, captchaToken: captchaToken || undefined }));
    setCaptchaToken("");
    setCaptchaReset((n) => n + 1);
    if (!result.ok) {
      setStatus("error");
      setMessage(result.message);
      trackAuthError("forgot_password", result.kind);
      return;
    }
    setStatus("sent");
    setMessage(
      `If an account exists for that email, a reset link is on its way. Open it on any device.${sentNote ? ` ${sentNote}` : ""}`,
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="forgot-email">Email</Label>
            <Input
              id="forgot-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@yourbrand.com"
            />
          </div>
          <Turnstile action="password_reset" onToken={setCaptchaToken} resetKey={captchaReset} />
          <Button type="submit" variant="secondary" className="w-full" disabled={status === "busy" || (turnstileEnabled && !captchaToken)}>
            {status === "busy" ? "Sending" : "Send reset link"}
          </Button>
          {message ? (
            <p
              role={status === "error" ? "alert" : "status"}
              className={"text-sm " + (status === "error" ? "text-red-600" : "text-emerald-700")}
            >
              {message}
            </p>
          ) : null}
        </form>
        <p className="mt-4 text-sm text-ink-500">
          Remembered it?{" "}
          {onLogIn ? (
            <button type="button" onClick={onLogIn} className="font-medium text-ink-900 underline">
              Log in
            </button>
          ) : (
            <Link href="/login" className="font-medium text-ink-900 underline">
              Log in
            </Link>
          )}
        </p>
      </CardContent>
    </Card>
  );
}

/** Sets a new password for the signed in user (recovery link session). */
export function ResetPasswordForm() {
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status | "checking" | "signedout">("checking");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    if (!supabase) {
      setStatus("signedout");
      return;
    }
    let active = true;
    supabase.auth
      .getUser()
      .then(({ data, error }) => {
        if (!active) {
          return;
        }
        if (!data.user && isNetworkAuthError(error)) {
          // Unreachable, not signed out: keep the form so they can retry.
          setStatus("error");
          setMessage(AUTH_NETWORK_ERROR);
          return;
        }
        setStatus(data.user ? "idle" : "signedout");
      })
      .catch(() => {
        if (active) {
          setStatus("error");
          setMessage(AUTH_NETWORK_ERROR);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = createSupabaseBrowserClient();
    if (!supabase) {
      setStatus("error");
      setMessage("Password reset is not available right now. Please try again later.");
      return;
    }
    setStatus("busy");
    setMessage(null);
    const result = await runAuthCall(() => supabase.auth.updateUser({ password }));
    if (!result.ok) {
      setStatus("error");
      setMessage(result.message);
      trackAuthError("reset_password", result.kind);
      return;
    }
    setStatus("sent");
    setMessage("Password updated. Taking you to your workspace.");
    window.setTimeout(() => {
      window.location.href = "/app";
    }, 1200);
  }

  if (status === "checking") {
    return <p className="text-sm text-ink-500">Checking your reset link.</p>;
  }
  if (status === "signedout") {
    return (
      <Card>
        <CardContent className="space-y-3 p-6">
          <p className="text-sm text-ink-600">
            This page needs an active reset link. Request a new one and open it on any device.
          </p>
          <Link href="/forgot-password" className="text-sm font-medium text-ink-900 underline">
            Request a reset link
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 8 characters"
            />
          </div>
          <Button type="submit" variant="secondary" className="w-full" disabled={status === "busy"}>
            {status === "busy" ? "Saving" : "Save new password"}
          </Button>
          {message ? (
            <p
              role={status === "error" ? "alert" : "status"}
              className={"text-sm " + (status === "error" ? "text-red-600" : "text-emerald-700")}
            >
              {message}
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
