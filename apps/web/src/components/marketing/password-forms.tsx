"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@curvi/ui";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type Status = "idle" | "busy" | "sent" | "error";

/** Requests a password recovery email through Supabase auth. */
export function ForgotPasswordForm() {
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
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) {
      setStatus("error");
      setMessage(error.message);
      return;
    }
    setStatus("sent");
    setMessage("If an account exists for that email, a reset link is on its way. Open it on this device.");
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
          <Button type="submit" variant="secondary" className="w-full" disabled={status === "busy"}>
            {status === "busy" ? "Sending" : "Send reset link"}
          </Button>
          {message ? (
            <p className={"text-sm " + (status === "error" ? "text-red-600" : "text-emerald-700")}>{message}</p>
          ) : null}
        </form>
        <p className="mt-4 text-sm text-ink-500">
          Remembered it?{" "}
          <Link href="/login" className="font-medium text-ink-900 underline">
            Log in
          </Link>
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
    supabase.auth.getUser().then(({ data }) => {
      setStatus(data.user ? "idle" : "signedout");
    });
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = createSupabaseBrowserClient();
    if (!supabase) {
      return;
    }
    setStatus("busy");
    setMessage(null);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setStatus("error");
      setMessage(error.message);
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
            This page needs an active reset link. Request a new one and open it on this device.
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
            <p className={"text-sm " + (status === "error" ? "text-red-600" : "text-emerald-700")}>{message}</p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
