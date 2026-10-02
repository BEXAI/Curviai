"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Input, Label, Textarea } from "@curvi/ui";
import { Turnstile, turnstileEnabled } from "./turnstile";

export function SupportForm({ signedIn = false, failureMessage }: { signedIn?: boolean; failureMessage: string }) {
  const [topic, setTopic] = useState("other");
  const [job, setJob] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [casePath, setCasePath] = useState("");
  const [error, setError] = useState("");
  const [token, setToken] = useState("");
  const [reset, setReset] = useState(0);
  const [requestId, setRequestId] = useState("");
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (["pack", "billing", "account", "other"].includes(params.get("topic") ?? "")) setTopic(params.get("topic")!);
    const jobId = params.get("job") ?? ""; setJob(/^[0-9a-f-]{36}$/i.test(jobId) ? jobId : ""); setRequestId(crypto.randomUUID());
  }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    setBusy(true); setError(""); setNotice(""); setCasePath("");
    try {
      const response = await fetch("/api/support", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic, message: form.get("message"), ...(signedIn ? {} : { email: form.get("email") }), ...(job ? { job } : {}), website: form.get("website"), requestId, captchaToken: token }) });
      const result = await response.json();
      if (!response.ok) setError(result.error ?? failureMessage);
      else { setNotice(result.notice); if (typeof result.casePath === "string" && /^\/app\/jobs\/[0-9a-f-]{36}\/cases#case-[0-9a-f-]{36}$/i.test(result.casePath)) setCasePath(result.casePath); setRequestId(crypto.randomUUID()); }
    } catch { setError(failureMessage); }
    finally { setBusy(false); setToken(""); setReset((n) => n + 1); }
  }
  return <form onSubmit={submit} className="mt-10 space-y-4 rounded-xl border border-ink-200 p-6">
    <h2 className="text-xl font-semibold">Contact us</h2>
    {!signedIn ? <div><Label htmlFor="support-email">Your email</Label><Input id="support-email" name="email" type="email" required autoComplete="email" /></div> : null}
    <div><Label htmlFor="support-topic">What do you need help with?</Label><select id="support-topic" value={topic} onChange={(e) => setTopic(e.target.value)} className="mt-1 block w-full rounded-lg border border-ink-200 bg-night p-3 text-sm"><option value="pack">A pack</option><option value="billing">Billing</option><option value="account">My account</option><option value="other">Something else</option></select></div>
    <div><Label htmlFor="support-message">Tell us what happened</Label><Textarea id="support-message" name="message" required minLength={10} maxLength={2000} rows={6} /></div>
    <div hidden aria-hidden="true"><label htmlFor="support-website">Website</label><input id="support-website" name="website" tabIndex={-1} autoComplete="off" /></div>
    {job ? <p className="text-xs text-ink-600">Pack reference attached.</p> : null}
    {!signedIn ? <Turnstile action="support" onToken={setToken} resetKey={reset} /> : null}
    <Button type="submit" disabled={busy || !requestId || (!signedIn && turnstileEnabled && !token)}>{busy ? "Sending" : "Send"}</Button>
    {notice ? <p role="status" className="text-sm text-ink-700">{notice}</p> : null}{error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
    {casePath ? <Link href={casePath} className="block text-sm underline">View your pack case</Link> : null}
  </form>;
}
