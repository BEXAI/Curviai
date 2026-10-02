import { randomUUID } from "node:crypto";
import React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { operatorCases } from "@/lib/ops/cases";
import { CASE_LABELS, CASE_STATUSES, STATUS_LABELS } from "@/lib/cases/types";
import { requireOperator } from "@/lib/ops/access";
import { getDb } from "@/lib/services/db";
import { isDbMode } from "@/lib/services";
import { caseAction } from "../actions";
export default async function OperatorCasePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireOperator(); if (!isDbMode()) notFound();
  const { id } = await params;
  const [item] = await operatorCases(getDb(), { userId: session.user.id, email: session.user.email! }, id); if (!item) notFound();
  return <div className="ph-no-capture ph-mask max-w-3xl space-y-6"><Link href="/app/ops/cases" className="underline">All cases</Link><h1 className="text-2xl font-semibold">{CASE_LABELS[item.case.category]}</h1><p>{STATUS_LABELS[item.case.status]}</p><p className="text-sm">Workspace {item.workspaceId}</p><Link href={`/app/ops/jobs/${item.case.jobId}`} className="underline">View pack details</Link>
    <section className="space-y-3"><h2 className="text-lg font-semibold">Seller timeline</h2>{item.case.events.map((event) => <div key={event.id} className="rounded border p-3"><p className="text-xs">{event.actor} {event.status ? STATUS_LABELS[event.status] : ""} {event.createdAt}</p><p className="whitespace-pre-wrap break-words">{event.message}</p></div>)}</section>
    <form action={caseAction} className="space-y-3 rounded border p-4"><h2 className="text-lg font-semibold">Reply to seller</h2><input type="hidden" name="caseId" value={id} /><input type="hidden" name="requestId" value={randomUUID()} /><label className="block">Status <select name="status" defaultValue={item.case.status} className="rounded border bg-night p-2">{CASE_STATUSES.filter((status) => item.case.status !== "resolved" || status === "resolved").map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}</select></label><label className="block">Explanation and next action<textarea name="message" required minLength={10} maxLength={2000} rows={4} className="block w-full rounded border bg-night p-2" /></label><p className="text-sm">This message is visible to the seller and workspace owners and admins. Resolving a case does not grant credits or run a pack.</p><button className="rounded border px-4 py-2">Save seller update</button></form>
    <section className="space-y-3"><h2 className="text-lg font-semibold">Private operator notes</h2>{item.notes.map((note) => <div key={note.id} className="rounded border p-3"><p className="text-xs">{note.createdAt}</p><p className="whitespace-pre-wrap break-words">{note.message}</p></div>)}<form action={caseAction} className="space-y-3"><input type="hidden" name="caseId" value={id} /><input type="hidden" name="private" value="yes" /><input type="hidden" name="requestId" value={randomUUID()} /><label className="block">Private note<textarea name="message" required minLength={10} maxLength={2000} rows={3} className="block w-full rounded border bg-night p-2" /></label><button className="rounded border px-4 py-2">Save private note</button></form></section>
  </div>;
}
