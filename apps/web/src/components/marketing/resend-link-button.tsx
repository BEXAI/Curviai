"use client";

import { useEffect, useState } from "react";
import { authUi } from "@curvi/pipeline/seed";
import { Button } from "@curvi/ui";
import { runAuthCall } from "@/lib/auth-call";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { safeNextPath } from "@/lib/safe-next";
import { Turnstile, turnstileEnabled } from "./turnstile";

export function ResendLinkButton({ email, next }: { email: string; next: string }) {
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [token, setToken] = useState("");
  const [reset, setReset] = useState(0);
  useEffect(() => {
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setRemaining((n) => Math.max(0, n - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [remaining]);
  async function resend() {
    const client = createSupabaseBrowserClient();
    if (!client || !email.trim()) { setMessage("Enter your email address above first."); return; }
    setBusy(true);
    const target = safeNextPath(next, window.location.origin);
    const result = await runAuthCall(() => client.auth.resend({ type: "signup", email, options: { captchaToken: token || undefined, emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(target)}` } }));
    setBusy(false); setToken(""); setReset((n) => n + 1); setRemaining(authUi.resendCooldownSeconds);
    setMessage(result.ok ? "If your email still needs confirming, a new link is on its way." : result.message);
  }
  return <div className="mt-4 space-y-3">
    <Turnstile action="resend" onToken={setToken} resetKey={reset} />
    <Button type="button" variant="outline" onClick={resend} disabled={busy || remaining > 0 || (turnstileEnabled && !token)}>Send the link again</Button>
    {remaining > 0 ? <p role="status" className="text-sm text-ink-600">You can send another link in {remaining} seconds.</p> : null}
    {message ? <p role="status" className="text-sm text-ink-600">{message}</p> : null}
  </div>;
}
