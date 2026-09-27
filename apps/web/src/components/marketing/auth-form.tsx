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
 * env state of this repo, it renders a launch notice with a waitlist capture
 * that falls back to a mailto link, so the page always works.
 */
export function AuthForm({ mode }: AuthFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "busy" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const fromQuery = new URLSearchParams(window.location.search).get("email");
    if (fromQuery) {
      setEmail(fromQuery);
    }
  }, []);

  if (!supabaseConfigured) {
    const subject = encodeURIComponent("Curvi waitlist");
    const body = encodeURIComponent(
      `Please add ${email || "my email"} to the Curvi waitlist.`,
    );
    return (
      <Card>
        <CardHeader>
          <CardTitle>Accounts open at launch</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-ink-600">
            We are onboarding the first customers in small batches. Leave your email and you will get
            an invite plus founding member pricing while the first 50 spots last.
          </p>
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              window.location.href = `mailto:hello@curvi.ai?subject=${subject}&body=${body}`;
              setStatus("sent");
            }}
          >
            <Label className="sr-only" htmlFor="waitlist-email">
              Email
            </Label>
            <Input
              id="waitlist-email"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@yourbrand.com"
              className="flex-1"
            />
            <Button type="submit" variant="secondary">
              Join the waitlist
            </Button>
          </form>
          {status === "sent" ? (
            <p className="text-sm text-emerald-700">
              Thanks. If your mail app did not open, email hello@curvi.ai and we will add you.
            </p>
          ) : (
            <p className="text-xs text-ink-400">
              This opens your mail app addressed to hello@curvi.ai. No tracking, no spam.
            </p>
          )}
          <p className="text-sm text-ink-500">
            While you wait, try the free tools:{" "}
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
    const result =
      mode === "signup"
        ? await supabase.auth.signUp({ email, password })
        : await supabase.auth.signInWithPassword({ email, password });
    if (result.error) {
      setStatus("error");
      setMessage(result.error.message);
      return;
    }
    if (mode === "signup" && !result.data.session) {
      setStatus("sent");
      setMessage("Check your inbox to confirm your email, then log in.");
      return;
    }
    window.location.href = "/app";
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
        <p className="mt-4 text-sm text-ink-500">
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
      </CardContent>
    </Card>
  );
}
