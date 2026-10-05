"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@curvi/ui";
import { GoogleSignInButton } from "@/components/marketing/google-sign-in-button";
import { ResendLinkButton } from "@/components/marketing/resend-link-button";
import { Turnstile, turnstileEnabled } from "@/components/marketing/turnstile";
import { collectSignupAttribution } from "@/lib/attribution";
import { runAuthCall, trackAuthError } from "@/lib/auth-call";
import { googleSignInEnabled } from "@/lib/google-sign-in";
import {
  DEFAULT_NEXT_PATH,
  authErrorMessage,
  confirmationSentMessage,
  parseCheckoutIntent,
  parseSignupSource,
  planIntentNote,
  postAuthDestination,
  postAuthParamsFrom,
  safeNextPath,
  type CheckoutIntent,
} from "@/lib/safe-next";
import { profileHintFrom, signupCallbackUrl, type SignupProfileHint } from "@/lib/signup-callback";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { EMPTY_SIGNUP_SOURCE_ANSWER, SignupSourceField, type SignupSourceAnswer } from "./signup-source-field";

export interface AuthFormProps {
  mode: "signup" | "login";
  /** Where to go after sign in (and after the email confirmation link),
   * instead of the query string's next. Always a same origin path; the
   * ChatGPT consent page passes its own URL (PHASE_19 P19-09). A pricing
   * intent in the query string is ignored when this is set. */
  next?: string;
  /** When set, "Log in" and "Create an account" switch the form in place
   * instead of linking to /login and /signup, whose header links to pricing. */
  onSwitchMode?: (mode: "signup" | "login") => void;
  /** The signup button's label (default "Start free"). */
  signupLabel?: string;
  /** The line shown when the confirmation email is on its way. */
  sentMessage?: string;
  /** Signup attribution, such as "chatgpt" (same rules as ?source=). */
  source?: string;
  /** When set, "Forgot password?" calls this instead of linking to
   * /forgot-password, whose marketing header links to pricing and which
   * drops next. Inside a flow (onSwitchMode set) without it, the link is
   * left out. */
  onForgotPassword?: () => void;
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

function TermsNotice({ google }: { google?: boolean }) {
  return (
    <p className="text-xs text-ink-500" data-testid="terms-notice">
      {google ? "By continuing with Google you agree to the " : "By creating an account you agree to the "}
      <Link href="/terms" className="font-medium text-ink-900 underline">
        Terms of service
      </Link>{" "}
      and{" "}
      <Link href="/privacy" className="font-medium text-ink-900 underline">
        Privacy policy
      </Link>
      .
    </p>
  );
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
export function AuthForm({
  mode,
  next,
  onSwitchMode,
  signupLabel,
  sentMessage,
  source: sourceProp,
  onForgotPassword,
}: AuthFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "busy" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [nextPath, setNextPath] = useState(DEFAULT_NEXT_PATH);
  const [intent, setIntent] = useState<CheckoutIntent | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [heard, setHeard] = useState<SignupSourceAnswer>(EMPTY_SIGNUP_SOURCE_ANSWER);
  // Welcome answers a category or channel page preselected (P18-20).
  const [profile, setProfile] = useState<SignupProfileHint>({});
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaReset, setCaptchaReset] = useState(0);
  const [showResend, setShowResend] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("email");
    if (fromQuery) {
      setEmail(fromQuery);
    }
    if (next !== undefined) {
      setNextPath(safeNextPath(next, window.location.origin));
      setSource(parseSignupSource(sourceProp ?? null));
    } else {
      setIntent(parseCheckoutIntent(params.get("plan"), params.get("cadence")));
      setSource(parseSignupSource(params.get("source")));
      setProfile(profileHintFrom(params));
      setNextPath(postAuthDestination(postAuthParamsFrom(params), window.location.origin));
    }
    const error = authErrorMessage(params.get("error"));
    if (error) {
      setStatus("error");
      setMessage(error);
      setShowResend(true);
    }
  }, [next, sourceProp]);

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
    // Where the signup came from (P18-01): this page's link, the consented
    // first touch cookie and the "How did you hear" answer. It rides in the
    // callback URL (attr) and, for an email signup, in the signup metadata.
    const attribution = collectSignupAttribution({ selfReported: heard.choice, other: heard.other });
    const callback = signupCallbackUrl(window.location.origin, { next: nextPath, attribution, profile });
    const result =
      mode === "signup"
        ? await runAuthCall(() =>
            supabase.auth.signUp({
              email,
              password,
              options: {
                captchaToken: captchaToken || undefined,
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
                  // Where the signup came from (P18-01), a hint the auth
                  // callback cleans again before storing it once.
                  attribution,
                },
              },
            }),
          )
        : await runAuthCall(() => supabase.auth.signInWithPassword({ email, password, options: { captchaToken: captchaToken || undefined } }));
    setCaptchaToken("");
    setCaptchaReset((n) => n + 1);
    if (!result.ok) {
      setStatus("error");
      setMessage(result.message);
      trackAuthError(mode, result.kind);
      setShowResend(true);
      return;
    }
    if (mode === "signup" && !result.value.data.session) {
      setStatus("sent");
      setMessage(sentMessage ?? confirmationSentMessage(intent, email));
      setShowResend(true);
      return;
    }
    // A signup confirmed at once (email confirmation off) goes through the
    // same callback a confirmation link opens, so the server records the
    // terms, where the signup came from and shows the welcome page.
    window.location.href = mode === "signup" ? callback : nextPath;
  }

  const switchQuery = carryQuery(intent, source, nextPath);
  // Google sign in (P18-13): above the email form, with the clickwrap terms
  // line above both buttons. Google can create an account from /login too,
  // so the login page shows the terms line above its Google button.
  const google = googleSignInEnabled();

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
        {google ? (
          <div className="mb-4 space-y-4" data-testid="google-section">
            {mode === "signup" ? <TermsNotice /> : <TermsNotice google />}
            <GoogleSignInButton
              mode={mode}
              redirectTo={() =>
                signupCallbackUrl(window.location.origin, {
                  next: nextPath,
                  attribution: collectSignupAttribution({ selfReported: heard.choice, other: heard.other }),
                  profile,
                  via: "google",
                })
              }
            />
            <p className="text-center text-xs text-ink-500">Or use your email</p>
          </div>
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
          {mode === "signup" ? <SignupSourceField value={heard} onChange={setHeard} /> : null}
          <Turnstile action={mode} onToken={setCaptchaToken} resetKey={captchaReset} />
          <Button type="submit" variant="secondary" className="w-full" disabled={status === "busy" || (turnstileEnabled && !captchaToken)}>
            {status === "busy" ? "Working" : mode === "signup" ? (signupLabel ?? "Start free") : "Log in"}
          </Button>
          {mode === "signup" && !google ? <TermsNotice /> : null}
          {message ? (
            <p
              role={status === "error" ? "alert" : "status"}
              className={"text-sm " + (status === "error" ? "text-red-600" : "text-emerald-700")}
            >
              {message}
            </p>
          ) : null}
        </form>
        {showResend ? <ResendLinkButton email={email} next={nextPath} /> : null}
        <div className="mt-4 flex items-center justify-between text-sm text-ink-500">
          <p>
            {mode === "signup" ? (
              <>
                Already have an account?{" "}
                {onSwitchMode ? (
                  <button type="button" onClick={() => onSwitchMode("login")} className="font-medium text-ink-900 underline">
                    Log in
                  </button>
                ) : (
                  <Link href={`/login${switchQuery}`} className="font-medium text-ink-900 underline">
                    Log in
                  </Link>
                )}
              </>
            ) : (
              <>
                New to Curvi?{" "}
                {onSwitchMode ? (
                  <button type="button" onClick={() => onSwitchMode("signup")} className="font-medium text-ink-900 underline">
                    Create an account
                  </button>
                ) : (
                  <Link href={`/signup${switchQuery}`} className="font-medium text-ink-900 underline">
                    Create an account
                  </Link>
                )}
              </>
            )}
          </p>
          {mode !== "login" ? null : onForgotPassword ? (
            <button type="button" onClick={onForgotPassword} className="font-medium text-ink-900 underline">
              Forgot password?
            </button>
          ) : onSwitchMode ? null : (
            <Link href="/forgot-password" className="font-medium text-ink-900 underline">
              Forgot password?
            </Link>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
