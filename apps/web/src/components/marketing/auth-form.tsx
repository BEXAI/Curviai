"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@curvi/ui";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export interface AuthFormProps {
  mode: "signup" | "login";
}

const supabaseConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

/**
 * Signup and login form. When Supabase is not configured, which is the zero
 * env state of this repo, it renders a temporary unavailability notice so
 * the page always works.
 */
export function AuthForm({ mode }: AuthFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "busy" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [nextPath, setNextPath] = useState("/app");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("email");
    if (fromQuery) {
      setEmail(fromQuery);
    }
    const next = params.get("next");
    if (next && next.startsWith("/") && !next.startsWith("//")) {
      setNextPath(next);
    }
    const error = params.get("error");
    if (error) {
      setStatus("error");
      setMessage(error);
    }
  }, []);

  if (!supabaseConfigured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Sign in is temporarily unavailable</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-ink-600">
            We are doing maintenance on accounts right now. Try again in a few minutes, or email{" "}
            <a href="mailto:hello@curvi.ai" className="font-medium text-ink-900 underline">
              hello@curvi.ai
            </a>{" "}
            if you need help getting in.
          </p>
          <p className="text-sm text-ink-500">
            In the meantime, the free tools work without an account:{" "}
            <Link href="/tools/main-image-checker" className="font-medium text-ink-900 underline">
              Main Image Checker
            </Link>
            ,{" "}
            <Link href="/tools/white-background-fixer" className="font-medium text-ink-900 underline">
              White Background Fixer
            </Link>{" "}
            and{" "}
            <Link href="/tools/marketplace-resizer" className="font-medium text-ink-900 underline">
              Marketplace Resizer
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = createSupabaseBrowserClient();
    if (!supabase) {
      setStatus("error");
      setMessage("Sign in is not available right now. Please try again later.");
      return;
    }
    setStatus("busy");
    setMessage(null);
    const callback = `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}`;
    const result =
      mode === "signup"
        ? await supabase.auth.signUp({ email, password, options: { emailRedirectTo: callback } })
        : await supabase.auth.signInWithPassword({ email, password });
    if (result.error) {
      setStatus("error");
      setMessage(result.error.message);
      return;
    }
    if (mode === "signup" && !result.data.session) {
      setStatus("sent");
      setMessage(
        "Almost there. We sent a confirmation link to your inbox. Open it on this device and your workspace will be ready. Check spam if it does not arrive in a minute.",
      );
      return;
    }
    window.location.href = nextPath;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{mode === "signup" ? "Create your account" : "Welcome back"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="auth-email">Email</Label>
            <Input
              id="auth-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@yourbrand.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="auth-password">Password</Label>
            <Input
              id="auth-password"
              type="password"
              required
              minLength={8}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 8 characters"
            />
          </div>
          <Button type="submit" variant="secondary" className="w-full" disabled={status === "busy"}>
            {status === "busy" ? "Working" : mode === "signup" ? "Start free" : "Log in"}
          </Button>
          {message ? (
            <p className={"text-sm " + (status === "error" ? "text-red-600" : "text-emerald-700")}>{message}</p>
          ) : null}
        </form>
        <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
          <p>
            {mode === "signup" ? (
              <>
                Already have an account?{" "}
                <Link href="/login" className="font-medium text-ink-900 underline">
                  Log in
                </Link>
              </>
            ) : (
              <>
                New to Curvi?{" "}
                <Link href="/signup" className="font-medium text-ink-900 underline">
                  Create an account
                </Link>
              </>
            )}
          </p>
          {mode === "login" ? (
            <Link href="/forgot-password" className="font-medium text-ink-900 underline">
              Forgot password?
            </Link>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
