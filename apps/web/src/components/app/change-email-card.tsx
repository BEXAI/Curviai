"use client";
import { useState } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@curvi/ui";
export function ChangeEmailCard({ email }: { email: string | null }) {
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  return <Card><CardHeader><CardTitle>Change email</CardTitle></CardHeader><CardContent>
    <p className="mb-4 break-all text-sm text-ink-600">{email ? `Your current email is ${email}.` : "Demo mode has no account email to change."}</p>
    <form className="space-y-3" onSubmit={async (event) => {
      event.preventDefault(); const value = new FormData(event.currentTarget).get("email"); setBusy(true); setMessage("");
      try { const response = await fetch("/api/account/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: value }) }); const result = await response.json(); setMessage(result.notice ?? result.error ?? "We could not change your email. Please try again."); }
      catch { setMessage("We could not reach the sign in service. Please try again."); } finally { setBusy(false); }
    }}><Label htmlFor="change-email">New email</Label><Input id="change-email" name="email" type="email" autoComplete="email" required disabled={!email} /><Button type="submit" disabled={!email || busy}>{busy ? "Sending" : "Send confirmation links"}</Button>{message ? <p role="status" className="text-sm text-ink-700">{message}</p> : null}</form>
  </CardContent></Card>;
}
