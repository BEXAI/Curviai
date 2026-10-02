import { notFound } from "next/navigation";
import { requireOperator } from "@/lib/ops/access";
import { operatorJobTimeline } from "@/lib/ops/jobs";
import { getDb } from "@/lib/services/db";
import { isDbMode } from "@/lib/services";
import { optionalEnv } from "@/lib/env";
import { jobAction } from "../actions";

export default async function OperatorJobPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOperator();
  if (!isDbMode()) return <p>Connect the database to view this pack.</p>;
  const { id } = await params;
  const timeline = await operatorJobTimeline(getDb(), id);
  if (!timeline) notFound();
  const { job } = timeline;
  const sentryOrg = optionalEnv("SENTRY_ORG");
  const details = { status: job.status, runKey: job.runKey, runnerId: job.runnerId, restartCount: job.restartCount, heartbeatAt: job.heartbeatAt,
    startedAt: job.startedAt, finishedAt: job.finishedAt, cogsMicros: job.cogsMicros, creditsReserved: job.creditsReserved, creditsCharged: job.creditsCharged,
    recipeVariants: job.recipeVariants, sellerNote: job.sellerNote, sellerIntent: job.sellerIntent, sellerAnswers: job.sellerAnswers };
  return <div className="space-y-6"><h1 className="text-2xl font-semibold">Pack {job.id}</h1><p>Workspace {job.workspaceId}</p>
    {sentryOrg ? <a className="underline" href={`https://sentry.io/organizations/${encodeURIComponent(sentryOrg)}/issues/?query=${encodeURIComponent(`job_id:${job.id}`)}`} target="_blank" rel="noopener noreferrer">Find this pack in Sentry</a> : <p className="text-sm text-ink-500">Sentry search is available when SENTRY_ORG is configured.</p>}
    <form action={jobAction} className="flex flex-wrap items-center gap-3 rounded border p-4"><input type="hidden" name="jobId" value={id} />
      <label className="flex items-center gap-2"><input type="checkbox" name="confirm" value="yes" required />Confirm this action</label>
      <label className="flex items-center gap-2"><input type="checkbox" name="force" value="yes" />Force even with a fresh heartbeat</label>
      <button name="action" value="settle" className="rounded border px-3 py-2">Settle now</button><button name="action" value="requeue" className="rounded border px-3 py-2">Requeue</button>
    </form>
    <div className="flex flex-wrap gap-3">{timeline.photos.filter((photo) => photo.url).map((photo, index) =>
      <img key={photo.id} src={photo.url!} alt={`Source photo ${index + 1}`} className="h-32 w-32 rounded object-contain" />)}</div>
    <section><h2 className="text-lg font-semibold">Steps</h2><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Stage</th><th>Provider</th><th>Attempt</th><th>Status</th><th>Cost</th><th>Latency</th><th>Error</th></tr></thead><tbody>{timeline.steps.map((step) => <tr key={step.id} className="border-t"><td>{step.stage}</td><td>{step.provider}</td><td>{step.attempt}</td><td>{step.status}</td><td>${(step.costMicros / 1000000).toFixed(4)}</td><td>{step.latencyMs ?? "unknown"} ms</td><td className="max-w-md break-words">{step.error}</td></tr>)}</tbody></table></div></section>
    {Object.entries({ Details: details, Assets: timeline.assets, "Pack files": timeline.files, Ledger: timeline.ledger, Events: timeline.events, "Language model spend": timeline.llm }).map(([title, data]) => <section key={title}><h2 className="text-lg font-semibold">{title}</h2><pre className="overflow-auto rounded bg-ink-50 p-4 text-xs">{JSON.stringify(data, null, 2)}</pre></section>)}
  </div>;
}
