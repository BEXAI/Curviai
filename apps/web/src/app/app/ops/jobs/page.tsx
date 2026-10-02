import Link from "next/link";
import { requireOperator } from "@/lib/ops/access";
import { listOperatorJobs } from "@/lib/ops/jobs";
import { getDb } from "@/lib/services/db";
import { isDbMode } from "@/lib/services";
import { opsViews } from "@curvi/pipeline/seed";

export default async function OperatorJobsPage({ searchParams }: { searchParams: Promise<{ filter?: string; workspace?: string; before?: string }> }) {
  await requireOperator();
  if (!isDbMode()) return <p>Connect the database to view packs.</p>;
  const query = await searchParams;
  const jobs = await listOperatorJobs(getDb(), { filter: query.filter, workspaceId: query.workspace, before: query.before });
  const older = new URLSearchParams({ ...(query.filter ? { filter: query.filter } : {}), ...(query.workspace ? { workspace: query.workspace } : {}), before: jobs.at(-1)?.created_at.toISOString() ?? "" });
  return <div className="space-y-5"><h1 className="text-2xl font-semibold">Jobs</h1>
    <form className="flex flex-wrap gap-3"><label>Show <select name="filter" defaultValue={query.filter ?? "all"} className="rounded border p-2"><option value="all">All packs</option><option value="failed">Failed</option><option value="stuck">Stuck</option><option value="review">Needs review</option></select></label>
      <label>Workspace <input name="workspace" defaultValue={query.workspace} placeholder="Workspace id" className="rounded border p-2" /></label><button className="rounded border px-3">Filter</button></form>
    <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Pack</th><th>Status</th><th>Created</th><th>Cost</th><th>Restarts</th></tr></thead><tbody>
      {jobs.map((job) => <tr key={job.id} className="border-t"><td className="py-3"><Link className="underline" href={`/app/ops/jobs/${job.id}`}>{job.title ?? job.id}</Link><p className="text-xs text-ink-500">{job.workspace_id}</p></td><td>{job.status}</td><td>{job.created_at.toISOString()}</td><td>${(Number(job.cogs_micros) / 1000000).toFixed(4)}</td><td>{job.restart_count}</td></tr>)}
    </tbody></table></div>
    {!jobs.length ? <p>No packs match these filters.</p> : null}
    {jobs.length === opsViews.jobPageSize ? <Link href={`/app/ops/jobs?${older}`} className="underline">Older packs</Link> : null}
  </div>;
}
