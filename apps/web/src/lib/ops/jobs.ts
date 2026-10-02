import { and, assets, creditLedger, eq, generationJobs, jobSteps, packFiles, sourceMedia, sql, type Db } from "@curvi/db";
import { opsViews, orphan } from "@curvi/pipeline/seed";
import { isUuid } from "@/lib/validation/ids";
import { isWorkspaceSourceKey, presignObjectGet } from "@/lib/r2";
import { requeueForRestart, restoredPayload } from "@/lib/jobs/restart";
import { settleJob } from "@/lib/jobs/settle";
import { opsEmails } from "@/lib/ops";
import { rowsOf } from "./overview";
import { writeOpsAudit } from "./audit";

export async function listOperatorJobs(db: Db, input: { filter?: string; workspaceId?: string; before?: string }, now = new Date()) {
  if (input.workspaceId && !isUuid(input.workspaceId)) throw new Error("Use a valid workspace id.");
  const cutoff = new Date(now.getTime() - orphan.staleHeartbeatMinutes * 60000);
  const filter = input.filter === "failed" ? sql`j.status = 'failed'`
    : input.filter === "stuck" ? sql`j.status not in ('done','failed','canceled') and coalesce(j.heartbeat_at,j.updated_at) < ${cutoff.toISOString()}::timestamptz`
    : input.filter === "review" ? sql`exists(select 1 from assets a where a.job_id = j.id and a.workspace_id = j.workspace_id and a.qc->>'status' = 'needs_review')`
    : sql`true`;
  const before = input.before && Number.isFinite(Date.parse(input.before)) ? new Date(input.before).toISOString() : null;
  const rows = rowsOf<{ id: string; workspace_id: string; status: string; created_at: Date | string; heartbeat_at: Date | string | null; restart_count: number; title: string | null; cogs_micros: string | number }>(await db.execute(sql`
    select j.id,j.workspace_id,j.status,j.created_at,j.heartbeat_at,j.restart_count,j.cogs_micros,p.title
    from generation_jobs j join products p on p.id = j.product_id and p.workspace_id = j.workspace_id
    where ${filter} and (${input.workspaceId ?? null}::uuid is null or j.workspace_id = ${input.workspaceId ?? null}::uuid)
      and (${before}::timestamptz is null or j.created_at < ${before}::timestamptz)
    order by j.created_at desc,j.id desc limit ${opsViews.jobPageSize}`));
  // Raw postgres-js results retain timestamp strings; unlike a typed
  // Drizzle select, execute does not apply the column's Date decoder.
  return rows.map((row) => ({ ...row,
    created_at: new Date(row.created_at),
    heartbeat_at: row.heartbeat_at === null ? null : new Date(row.heartbeat_at),
  }));
}

export async function operatorJobTimeline(db: Db, jobId: string, sign = presignObjectGet) {
  if (!isUuid(jobId)) return null;
  const job = await db.query.generationJobs.findFirst({ where: eq(generationJobs.id, jobId) });
  if (!job) return null;
  const workspace = job.workspaceId;
  const [steps, output, files, ledger, media, events, llm] = await Promise.all([
    db.select().from(jobSteps).where(and(eq(jobSteps.jobId, jobId), eq(jobSteps.workspaceId, workspace))).orderBy(jobSteps.createdAt).limit(opsViews.timelineRows),
    db.select().from(assets).where(and(eq(assets.jobId, jobId), eq(assets.workspaceId, workspace))).limit(opsViews.timelineRows),
    db.select().from(packFiles).where(and(eq(packFiles.jobId, jobId), eq(packFiles.workspaceId, workspace))).limit(opsViews.timelineRows),
    db.select().from(creditLedger).where(and(eq(creditLedger.jobId, jobId), eq(creditLedger.workspaceId, workspace))).orderBy(creditLedger.createdAt).limit(opsViews.timelineRows),
    db.select({ id: sourceMedia.id, key: sourceMedia.r2Key }).from(sourceMedia).where(and(eq(sourceMedia.productId, job.productId), eq(sourceMedia.workspaceId, workspace))).limit(opsViews.overviewRows),
    db.execute(sql`select at,name,props from events where workspace_id = ${workspace}::uuid and (props->>'jobId' = ${jobId} or props->>'job_id' = ${jobId}) order by at limit ${opsViews.timelineRows}`),
    db.execute(sql`select key,total_micros from spend_cap_counters where key like ${`llm|job|${jobId}|%`} limit ${opsViews.timelineRows}`),
  ]);
  const photos = await Promise.all(media.filter((photo) => isWorkspaceSourceKey(workspace, photo.key)).map(async (photo) => ({
    id: photo.id, url: await sign(photo.key, opsViews.signedPhotoSeconds).catch(() => null),
  })));
  return { job, steps, assets: output, files, ledger, photos, events: rowsOf(events), llm: rowsOf(llm) };
}

export function hasFreshHeartbeat(at: Date | null, now: Date): boolean {
  return at !== null && at.getTime() > now.getTime() - orphan.staleHeartbeatMinutes * 60000;
}

/** Fence and audit the mutation in the same transaction. Force is always recorded. */
export async function operateJob(db: Db, input: { jobId: string; action: "settle" | "requeue"; forced: boolean; operator: string }, now = new Date()): Promise<{ workspaceId: string; requeued: boolean }> {
  if (!opsEmails().includes(input.operator.trim().toLowerCase()) || !isUuid(input.jobId)) throw new Error("A valid operator and job are required.");
  return db.transaction(async (tx) => {
    const initial = await tx.query.generationJobs.findFirst({ where: eq(generationJobs.id, input.jobId) });
    if (!initial) throw new Error("Pack not found.");
    await tx.execute(sql`select id from workspaces where id = ${initial.workspaceId}::uuid for update`);
    await tx.execute(sql`select id from generation_jobs where id = ${input.jobId}::uuid for update`);
    const job = await tx.query.generationJobs.findFirst({ where: eq(generationJobs.id, input.jobId) });
    if (!job) throw new Error("Pack not found.");
    if (!input.forced && hasFreshHeartbeat(job.heartbeatAt, now)) throw new Error("This runner still has a fresh heartbeat. Wait, or explicitly choose Force.");
    const cutoff = new Date(now.getTime() - orphan.staleHeartbeatMinutes * 60000);
    const onlyIf = input.forced ? sql`true` : sql`(heartbeat_at is null or heartbeat_at <= ${cutoff.toISOString()}::timestamptz)`;
    const nested = tx as unknown as Db;
    if (input.action === "settle") {
      await settleJob(nested, { jobId: job.id, workspaceId: job.workspaceId }, { undelivered: "failed", error: "This pack was stopped by support. Reserved credits were released.", onlyIf, now });
    } else {
      const payload = restoredPayload({ id: job.id, workspace_id: job.workspaceId, restart_payload: job.restartPayload }, job.runKey ?? "");
      if (!payload) throw new Error("This pack has no recoverable input.");
      const result = await requeueForRestart(nested, payload, job.status === "queued" && !job.startedAt ? "not_started" : "interrupted", { now, allowFailed: true, onlyIf });
      if (!result.requeued) throw new Error(`This pack cannot restart: ${result.why}.`);
    }
    await writeOpsAudit(tx, { operatorEmail: input.operator, action: `job.${input.action}`, targetKind: "job", targetId: job.id,
      workspaceId: job.workspaceId, forced: input.forced, detail: { statusBefore: job.status, runKeyBefore: job.runKey, restartCountBefore: job.restartCount } }, now);
    return { workspaceId: job.workspaceId, requeued: input.action === "requeue" };
  });
}
