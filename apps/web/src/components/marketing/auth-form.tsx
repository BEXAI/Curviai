"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@curvi/ui";
import { runAuthCall, trackAuthError } from "@/lib/auth-call";
import {
  DEFAULT_NEXT_PATH,
  authErrorMessage,
  confirmationSentMessage,
  parseCheckoutIntent,
  parseSignupSource,
  planIntentNote,
  postAuthDestination,
  postAuthParamsFrom,
  type CheckoutIntent,
} from "@/lib/safe-next";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export interface AuthFormProps {
  mode: "signup" | "login";
}

const supabaseConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

/** Query string that carries the pricing intent and next path between the
 * signup and login pages. */
function carryQuery(intent: CheckoutIntent | null, source: string | null, nextPath: string): string {
  const params = new URLSearchParams();
  if (intent) {
    params.set("plan", intent.plan);
    params.set("cadence", intent.cadence);
  } else if (nextPath !== DEFAULT_NEXT_PATH) {
    params.set("next", nextPath);
  }
  if (source) {
    params.set("source", source);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * Signup and login form. Reads next, plan, cadence and source from the query
 * string: a plan picked on the pricing page (validated against the tiers
 * seed) sends the user to that plan on the billing page after signup or login
 * (a checkout with Stripe, an upgrade request without it), and
 * next is only ever a same origin path (Update.md 4.3). When Supabase is not
 * configured, which is the zero env state of this repo, it renders a
 * temporary unavailability notice so the page always works.
 */
export function AuthForm({ mode }: AuthFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "busy" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [nextPath, setNextPath] = useState(DEFAULT_NEXT_PATH);
  const [intent, setIntent] = useState<CheckoutIntent | null>(null);
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("email");
    if (fromQuery) {
      setEmail(fromQuery);
    }
    setIntent(parseCheckoutIntent(params.get("plan"), params.get("cadence")));
    setSource(parseSignupSource(params.get("source")));
    setNextPath(postAuthDestination(postAuthParamsFrom(params), window.location.origin));
    const error = authErrorMessage(params.get("error"));
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
        ? await runAuthCall(() =>
            supabase.auth.signUp({
              email,
              password,
              options: {
                emailRedirectTo: callback,
                // Clickwrap: the signup button sits above the Terms and
                // Privacy notice, so submitting is the acceptance. The user
                // can edit this metadata, so it is a hint only; the record
                // that counts is the server's terms_acceptances row
                // (lib/trust/terms.ts).
                data: {
                  terms_accepted_at: new Date().toISOString(),
                  ...(source ? { signup_source: source } : {}),
                  ...(intent ? { plan_intent: intent.plan, cadence_intent: intent.cadence } : {}),
                },
              },
            }),
          )
        : await runAuthCall(() => supabase.auth.signInWithPassword({ email, password }));
    if (!result.ok) {
      setStatus("error");
      setMessage(result.message);
      trackAuthError(mode, result.kind);
      return;
    }
    if (mode === "signup" && !result.value.data.session) {
      setStatus("sent");
      setMessage(confirmationSentMessage(intent));
      return;
    }
    window.location.href = nextPath;
  }

  const switchQuery = carryQuery(intent, source, nextPath);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{mode === "signup" ? "Create your account" : "Welcome back"}</CardTitle>
      </CardHeader>
      <CardContent>
        {intent ? (
          <p className="mb-4 rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-700" data-testid="plan-intent">
            {planIntentNote(mode, intent)}
          </p>
        ) : null}
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
          {mode === "signup" ? (
            <p className="text-xs text-ink-500" data-testid="terms-notice">
              By creating an account you agree to the{" "}
              <Link href="/terms" className="font-medium text-ink-900 underline">
                Terms of service
              </Link>{" "}
              and{" "}
              <Link href="/privacy" className="font-medium text-ink-900 underline">
                Privacy policy
              </Link>
              .
            </p>
          ) : null}
          {message ? (
            <p
              role={status === "error" ? "alert" : "status"}
              className={"text-sm " + (status === "error" ? "text-red-600" : "text-emerald-700")}
            >
              {message}
            </p>
          ) : null}
        </form>
        <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
          <p>
            {mode === "signup" ? (
              <>
                Already have an account?{" "}
                <Link href={`/login${switchQuery}`} className="font-medium text-ink-900 underline">
                  Log in
                </Link>
              </>
            ) : (
              <>
                New to Curvi?{" "}
                <Link href={`/signup${switchQuery}`} className="font-medium text-ink-900 underline">
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
