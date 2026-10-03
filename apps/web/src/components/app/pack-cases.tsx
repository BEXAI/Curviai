"use client";
import React, { useRef, useState } from "react";
import { Button, Label, Textarea } from "@curvi/ui";
import { packCasesPolicy } from "@curvi/pipeline/seed";
import { CASE_CATEGORIES, CASE_LABELS, STATUS_LABELS, type CaseList, type PackCase } from "@/lib/cases/types";

function Timeline({ value }: { value: PackCase }) {
  return <ol aria-label="Case timeline" className="space-y-4 border-l pl-4">{value.events.map((event) => <li key={event.id}>
    <p className="text-sm font-medium">{event.actor === "operator" ? "Curvi" : event.actor === "seller" ? "Workspace member" : "Update"}{event.status ? `: ${STATUS_LABELS[event.status]}` : ""}</p>
    <time dateTime={event.createdAt} className="text-xs text-ink-500">{new Date(event.createdAt).toLocaleString()}</time>
    <p className="whitespace-pre-wrap break-words text-sm">{event.message}</p>
  </li>)}</ol>;
}
function CaseCard({ value, jobId, onUpdate }: { value: PackCase; jobId: string; onUpdate: (value: PackCase) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const request = useRef<string | null>(null);
  async function reply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, data = new FormData(form);
    request.current ??= crypto.randomUUID(); setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/jobs/${jobId}/cases/${value.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: data.get("message"), requestId: request.current, reopen: value.status === "resolved" }) });
      const result = await response.json();
      if (!response.ok) { setError(result.error ?? "We could not save your reply."); if (response.status < 500) request.current = null; }
      else { onUpdate(result.case); request.current = null; form.reset(); setNotice("Your reply was saved."); }
    } catch { setError("We could not save your reply. Try again."); }
    finally { setBusy(false); }
  }
  return <section id={`case-${value.id}`} className="space-y-4 rounded-xl border border-ink-200 p-5" aria-labelledby={`title-${value.id}`}>
    <div><h2 id={`title-${value.id}`} className="text-lg font-semibold">{CASE_LABELS[value.category]}</h2><p className="text-sm">{STATUS_LABELS[value.status]}</p></div>
    <p className="text-xs text-ink-500">Case reference: {value.id}</p>
    {value.shotId ? <p className="text-sm">Shot reference: {value.shotId}</p> : null}
    {value.versionId ? <p className="text-sm">Output file reference: {value.versionId}</p> : null}
    {value.feedbackLinked || value.supportLinked ? <p className="text-sm">Your existing {value.feedbackLinked ? "pack feedback" : "support report"} is linked to this case.</p> : null}
    <Timeline value={value} />
    <p className="text-xs text-ink-500">Showing the latest {packCasesPolicy.timelinePageSize} timeline entries. Workspace owners and admins can export the full history in Settings.</p>
    {value.status !== "resolved" || value.canReopen ? <form onSubmit={reply} className="space-y-3">
      <Label htmlFor={`reply-${value.id}`}>Your reply</Label><Textarea id={`reply-${value.id}`} name="message" minLength={10} maxLength={2000} required rows={3} aria-describedby={error ? `error-${value.id}` : undefined} />
      {value.status === "resolved" ? <p className="text-sm">Sending this reply reopens your case. Cases may be reopened within {packCasesPolicy.reopenDays} days of resolution.</p> : null}
      <Button type="submit" disabled={busy}>{busy ? "Saving" : value.status === "resolved" ? "Reopen case" : "Send reply"}</Button>
    </form> : <p className="text-sm">This case was resolved more than 30 days ago. Start a new report if you still need help.</p>}
    {error ? <p id={`error-${value.id}`} role="alert" className="text-sm text-red-600">{error}</p> : null}
    {notice ? <p role="status" className="text-sm">{notice}</p> : null}
  </section>;
}
export function PackCases({ jobId, initial, shots, files = [] }: { jobId: string; initial: CaseList; shots: { id: string; label: string }[]; files?: { id: string; label: string; shotId: string | null }[] }) {
  const [cases, setCases] = useState(initial.cases), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const request = useRef<string | null>(null);
  const upsert = (value: PackCase) => setCases((current) => [value, ...current.filter((item) => item.id !== value.id)]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, data = new FormData(form);
    request.current ??= crypto.randomUUID(); setBusy(true); setError(""); setNotice("");
    const version = files.find((file) => file.id === data.get("versionId"));
    const shotId = version ? version.shotId : data.get("shotId");
    try {
      const response = await fetch(`/api/jobs/${jobId}/cases`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category: data.get("category"), description: data.get("description"), requestId: request.current, ...(shotId ? { shotId } : {}), ...(version ? { versionId: version.id } : {}) }) });
      const result = await response.json();
      if (!response.ok) { setError(result.error ?? "We could not save your report."); if (response.status < 500) request.current = null; }
      else { upsert(result.case); request.current = null; form.reset(); setNotice(result.created ? "Your report was received. Follow its progress below." : "There is already a case for this category. Continue the conversation below."); }
    } catch { setError("We could not save your report. Try again."); }
    finally { setBusy(false); }
  }
  return <div className="ph-no-capture ph-mask space-y-6">
    <p className="text-sm">Your report is visible to you and workspace owners and admins. A resolution explains what happens next. It does not automatically add credits or rerun your pack.</p>
    {initial.sourceUnavailable ? <p role="status" className="rounded-lg border p-4 text-sm">An original photo used for this pack is no longer available. Upload a new photo when you create another pack. Reporting a problem does not extend photo storage.</p> : null}
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-ink-200 p-5">
      <h2 className="text-lg font-semibold">Report a pack problem</h2>
      <div><Label htmlFor="case-category">What needs attention?</Label><select id="case-category" name="category" className="mt-1 block w-full rounded border bg-night p-3">{CASE_CATEGORIES.map((category) => <option key={category} value={category}>{CASE_LABELS[category]}</option>)}</select></div>
      <div><Label htmlFor="case-shot">Shot reference (optional)</Label><select id="case-shot" name="shotId" className="mt-1 block w-full rounded border bg-night p-3"><option value="">The whole pack</option>{shots.map((shot) => <option key={shot.id} value={shot.id}>{shot.label}</option>)}</select></div>
      {files.length ? <div><Label htmlFor="case-version">Output file reference (optional)</Label><select id="case-version" name="versionId" className="mt-1 block w-full rounded border bg-night p-3"><option value="">No specific file</option>{files.map((file) => <option key={file.id} value={file.id}>{file.label}</option>)}</select><p className="text-xs text-ink-500">Choosing a file also attaches its shot reference.</p></div> : null}
      <div><Label htmlFor="case-description">What happened?</Label><Textarea id="case-description" name="description" required minLength={10} maxLength={2000} rows={4} aria-describedby="case-description-help" /><p id="case-description-help" className="text-xs text-ink-500">Write 10 to 2,000 characters. Do not include passwords or payment details.</p></div>
      <Button type="submit" disabled={busy}>{busy ? "Saving" : "Send report"}</Button>
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}{notice ? <p role="status" className="text-sm">{notice}</p> : null}
    </form>
    {cases.length ? <div className="space-y-5" aria-label="Your cases">{cases.map((value) => <CaseCard key={value.id} value={value} jobId={jobId} onUpdate={upsert} />)}</div> : <p>No reports for this pack yet.</p>}
    <p className="text-xs text-ink-500">Showing up to {packCasesPolicy.casePageSize} recently updated cases. Resolved cases and their messages are removed after {packCasesPolicy.resolvedRetentionDays} days. Workspace deletion removes its cases. Workspace owners and admins can export public case history in Settings.</p>
  </div>;
}
