"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@curvi/ui";
import { runAuthCall, trackAuthError } from "@/lib/auth-call";
import { changePassword, loadPasswordSession, sendPasswordCode, type PasswordChangeResult, type PasswordSession } from "@/lib/auth/password-change";
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

/** Recovery links and ordinary account password changes share this page. */
export function ResetPasswordForm() {
  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [nonce, setNonce] = useState("");
  const [session, setSession] = useState<PasswordSession | null>(null);
  const [currentRequired, setCurrentRequired] = useState(false);
  const [nonceRequired, setNonceRequired] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [checkAttempt, setCheckAttempt] = useState(0);
  const [status, setStatus] = useState<Status | "checking" | "signedout">("checking");
  const [message, setMessage] = useState<string | null>(null);
  const operation = useRef({ generation: 0, busy: false });

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    if (!supabase) return;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_OUT" && event !== "SIGNED_IN" && event !== "PASSWORD_RECOVERY") return;
      operation.current.generation += 1;
      operation.current.busy = false;
      clearCredentials();
      setSession(null);
      setCurrentRequired(false);
      setNonceRequired(false);
      setCodeSent(false);
      setMessage(null);
      setStatus(event === "SIGNED_OUT" ? "signedout" : "checking");
      // No SDK calls inside its callback/lock. The effect verifies the new session.
      setCheckAttempt((n) => n + 1);
    });
    return () => { operation.current.generation += 1; subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    if (!supabase) {
      setStatus("signedout");
      return;
    }
    let active = true;
    const generation = operation.current.generation;
    void loadPasswordSession(supabase.auth).then((result) => {
      if (!active || generation !== operation.current.generation) return;
      if (result.kind === "ready") {
        setSession(result.session);
        setStatus("idle");
      } else {
        setStatus(result.kind === "signedout" ? "signedout" : "error");
        if (result.kind === "error") setMessage(result.message);
      }
    });
    return () => {
      active = false;
    };
  }, [checkAttempt]);

  function clearCredentials() {
    setPassword("");
    setCurrentPassword("");
    setNonce("");
  }

  function handleFailure(result: Exclude<PasswordChangeResult, { kind: "success" }>) {
    if (result.kind === "cancelled") return;
    if (result.kind === "changed" || result.kind === "signedout") {
      clearCredentials();
      setCurrentRequired(false);
      setNonceRequired(false);
      setCodeSent(false);
      setSession(result.kind === "changed" ? result.session : null);
      setStatus(result.kind === "signedout" ? "signedout" : "idle");
      setMessage("Your sign in changed. Enter your passwords again before saving.");
      return;
    }
    if (result.required === "current_password") setCurrentRequired(true);
    if (result.required === "nonce") { setNonceRequired(true); setNonce(""); }
    setStatus("error");
    setMessage(result.message);
    trackAuthError("reset_password", result.errorKind);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (operation.current.busy || status === "sent") return;
    const supabase = createSupabaseBrowserClient();
    if (!supabase || !session) {
      setStatus("error");
      setMessage("Password reset is not available right now. Please try again later.");
      return;
    }
    operation.current.busy = true;
    const generation = operation.current.generation;
    setStatus("busy");
    setMessage(null);
    const result = await changePassword(supabase.auth, session, { password, currentPassword, nonce }, () => generation === operation.current.generation);
    if (generation !== operation.current.generation) return;
    if (result.kind !== "success") {
      operation.current.busy = false;
      handleFailure(result);
      return;
    }
    clearCredentials();
    setStatus("sent");
    setMessage("Password updated. Taking you to your workspace.");
    window.setTimeout(() => {
      if (generation === operation.current.generation) window.location.href = "/app";
    }, 1200);
  }

  async function sendCode() {
    if (operation.current.busy || status === "sent") return;
    const supabase = createSupabaseBrowserClient();
    if (!supabase || !session) return;
    operation.current.busy = true;
    const generation = operation.current.generation;
    setStatus("busy");
    setMessage(null);
    setNonce("");
    const result = await sendPasswordCode(supabase.auth, session, () => generation === operation.current.generation);
    if (generation !== operation.current.generation) return;
    operation.current.busy = false;
    if (result.kind !== "success") { handleFailure(result); return; }
    setCodeSent(true);
    setStatus("idle");
    setMessage("We sent a verification code to your confirmed email address or phone. Enter it below.");
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

  if (!session) {
    return <div className="space-y-3">
      <p role="alert" className="text-sm text-red-600">{message}</p>
      <Button type="button" variant="secondary" onClick={() => { setStatus("checking"); setMessage(null); setCheckAttempt((n) => n + 1); }}>Try again</Button>
    </div>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={submit}>
          {(!session.recovery || currentRequired) ? <div className="space-y-1.5">
            <Label htmlFor="current-password">Current password</Label>
            <Input id="current-password" type="password" autoComplete="current-password" required={currentRequired}
              value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} disabled={status === "busy" || status === "sent"} />
            <p className="text-xs text-ink-500">If your account does not have a password yet, leave this blank. <Link href="/forgot-password" className="underline">Forgot your password?</Link></p>
          </div> : null}
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
              disabled={status === "busy" || status === "sent"}
              placeholder="At least 8 characters"
            />
          </div>
          {nonceRequired ? <div className="space-y-2">
            <Button type="button" variant="outline" onClick={sendCode} disabled={status === "busy" || status === "sent"}>
              {codeSent ? "Send a new verification code" : "Send verification code"}
            </Button>
            <Label htmlFor="password-code">Verification code</Label>
            <Input id="password-code" autoComplete="one-time-code" inputMode="numeric" required value={nonce}
              onChange={(event) => setNonce(event.target.value)} disabled={status === "busy" || status === "sent"} />
          </div> : null}
          <Button type="submit" variant="secondary" className="w-full" disabled={status === "busy" || status === "sent"}>
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
