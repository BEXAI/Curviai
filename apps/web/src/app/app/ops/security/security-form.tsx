"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label } from "@curvi/ui";
import { enrollOperatorFactor, removeOperatorFactor, verifyOperatorFactor, type SecurityResult } from "./actions";
export function OperatorSecurityForm({ aal, factors }: { aal: "aal1" | "aal2"; factors: Array<{ id: string; label: string; status: string }> }) {
  const router = useRouter();
  const verified = factors.filter((factor) => factor.status === "verified");
  const [enrollment, setEnrollment] = useState<SecurityResult["enrollment"]>();
  const [factorId, setFactorId] = useState(verified[0]?.id ?? "");
  const [code, setCode] = useState("");
  const [result, setResult] = useState<SecurityResult>({});
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  async function act(work: () => Promise<SecurityResult>) {
    setBusy(true); setResult({});
    try {
      const response = await work(); setResult(response);
      if (response.enrollment) { setEnrollment(response.enrollment); setFactorId(response.enrollment.id); }
      if (response.verified) { setEnrollment(undefined); setCode(""); router.refresh(); }
      if (!response.error && !response.enrollment) router.refresh();
    } catch { setResult({ error: "We could not update your sign in security. Please try again." }); }
    finally { setBusy(false); }
  }
  return <div className="max-w-xl space-y-6">
    <p className="text-sm text-ink-600">{aal === "aal2" ? "This session has passed the authenticator check." : "Enter an authenticator code to open the operator pages."}</p>
    {enrollment ? <div className="space-y-3 rounded-lg border p-4"><p>Scan this code with your authenticator app.</p>{enrollment.qrCode.startsWith("data:image/svg+xml") ? <img src={enrollment.qrCode} width={200} height={200} alt="Authenticator enrollment QR code" className="bg-white p-2" /> : null}<p className="text-sm">Or enter this setup key manually:</p><code className="block break-all rounded bg-ink-100 p-3 text-sm" aria-label="Authenticator setup key">{enrollment.secret}</code><p className="text-sm text-ink-600">Keep this key private. It is shown only during setup.</p></div> : null}
    {(enrollment || verified.length > 0) && (aal !== "aal2" || enrollment) ? <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void act(() => verifyOperatorFactor(factorId, code)); }}>
      {!enrollment && verified.length > 1 ? <label className="block text-sm">Authenticator<select value={factorId} onChange={(event) => setFactorId(event.target.value)} className="mt-1 block w-full rounded border bg-night p-2">{verified.map((factor) => <option key={factor.id} value={factor.id}>{factor.label}</option>)}</select></label> : null}
      <Label htmlFor="operator-code">Authenticator code</Label><Input id="operator-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required maxLength={6} />
      <Button disabled={busy || code.length !== 6} type="submit">Verify code</Button>
    </form> : null}
    {(!verified.length || aal === "aal2") && !enrollment ? <Button disabled={busy} onClick={() => void act(enrollOperatorFactor)}>{verified.length ? "Add another authenticator" : "Set up an authenticator"}</Button> : null}
    {aal === "aal2" || !verified.length ? <ul className="space-y-3">{factors.map((factor) => <li key={factor.id} className="rounded-lg border p-3"><span className="text-sm">{factor.label} ({factor.status === "verified" ? "Verified" : "Setup incomplete"})</span>{removing === factor.id ? <div className="mt-3 space-y-2"><p className="text-sm">Remove this authenticator? If it is your last one, you will need to enroll again before opening operator pages.</p><Button size="sm" variant="danger" disabled={busy} onClick={() => void act(() => removeOperatorFactor(factor.id)).then(() => setRemoving(null))}>Yes, remove it</Button><Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>Keep it</Button></div> : <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(factor.id)}>Remove</Button>}</li>)}</ul> : null}
    {result.error ? <p role="alert" className="text-sm text-red-600">{result.error}</p> : null}{result.notice ? <p role="status" className="text-sm">{result.notice}</p> : null}
  </div>;
}
