import { sql, type Db } from "@curvi/db";
import { packCasesPolicy } from "@curvi/pipeline/seed";
import { isUuid } from "@/lib/validation/ids";
import { purgeCutoff } from "@/lib/trust/purge";
import { canReopen, CaseRefusal, createCaseInput, replyCaseInput, type CaseActor, type CaseEvent, type CaseList, type CaseStatus, type CreateCaseInput, type PackCase, type ReplyCaseInput } from "./types";
import type { CaseStore } from "./store";

type Executor = Pick<Db, "execute">;
export const rows = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows?: T[] })?.rows ?? []) as T[];
export const iso = (value: Date | string) => new Date(value).toISOString();
export interface CaseRow { id: string; workspace_id: string; job_id: string; reporter_user_id: string; category: PackCase["category"]; status: CaseStatus; description: string; shot_id: string | null; version_id: string | null; feedback_id: string | null; source_support_request_id: string | null; created_at: Date | string; updated_at: Date | string; resolved_at: Date | string | null }
export const publicColumns = sql`c.id, c.workspace_id, c.job_id, c.reporter_user_id, c.category, c.status, c.description, c.shot_id, c.version_id, c.feedback_id, c.source_support_request_id, c.created_at, c.updated_at, c.resolved_at`;
export const missing = () => new CaseRefusal("not_found", "This case or pack is not available.");
async function membership(db: Executor, actor: CaseActor): Promise<string | null> {
  if (!isUuid(actor.workspaceId) || !isUuid(actor.userId)) return null;
  return rows<{ role: string }>(await db.execute(sql`select role from members where workspace_id=${actor.workspaceId}::uuid and user_id=${actor.userId}::uuid`))[0]?.role ?? null;
}
function visible(row: CaseRow, actor: CaseActor, role: string) { return row.workspace_id === actor.workspaceId && (row.reporter_user_id === actor.userId || role === "owner" || role === "admin"); }
export async function project(db: Executor, row: CaseRow, now: Date): Promise<PackCase> {
  const events = rows<{ id: string; actor_kind: CaseEvent["actor"]; status: CaseStatus | null; message: string; created_at: Date | string }>(await db.execute(sql`
    select id, actor_kind, status, message, created_at from (select id, actor_kind, status, message, created_at
      from pack_case_events where case_id=${row.id}::uuid and workspace_id=${row.workspace_id}::uuid order by created_at desc, id desc limit ${packCasesPolicy.timelinePageSize}) recent order by created_at, id`));
  return { id: row.id, jobId: row.job_id, category: row.category, status: row.status, description: row.description, shotId: row.shot_id, versionId: row.version_id,
    feedbackLinked: Boolean(row.feedback_id), supportLinked: Boolean(row.source_support_request_id), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    resolvedAt: row.resolved_at ? iso(row.resolved_at) : null, canReopen: row.status === "resolved" && canReopen(row.resolved_at, now),
    events: events.map((event) => ({ id: event.id, actor: event.actor_kind, status: event.status, message: event.message, createdAt: iso(event.created_at) })) };
}
export async function addEvent(db: Executor, row: CaseRow, actorId: string, actor: "seller" | "operator", requestId: string, message: string, status: CaseStatus | null) {
  await db.execute(sql`insert into pack_case_events(workspace_id,case_id,actor_user_id,actor_kind,request_id,message,status)
    values(${row.workspace_id}::uuid,${row.id}::uuid,${actorId}::uuid,${actor},${requestId}::uuid,${message},${status})`);
}

/** Owner DB connection: every customer access resolves current membership again. */
export class DbCaseStore implements CaseStore {
  constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {}
  async list(actor: CaseActor, jobId: string): Promise<CaseList | null> {
    const role = await membership(this.db, actor);
    if (!role || !isUuid(jobId)) return null;
    const cutoff = purgeCutoff(this.now()).toISOString();
    const job = rows<{ id: string; source_available: boolean }>(await this.db.execute(sql`with available_sources as (
      select s.* from source_media s where s.workspace_id=${actor.workspaceId}::uuid and (
        s.created_at >= ${cutoff}::timestamptz
        or exists(select 1 from generation_jobs recent where recent.product_id=s.product_id and recent.workspace_id=s.workspace_id
          and (greatest(recent.created_at,coalesce(recent.started_at,recent.created_at)) >= ${cutoff}::timestamptz or recent.status not in ('done','failed','canceled')))
        or exists(select 1 from share_links shared where shared.before_media_id=s.id)))
      select j.id,
      (exists(select 1 from available_sources s where s.workspace_id=j.workspace_id and s.product_id=j.product_id)
       and not exists(select 1 from assets a where a.workspace_id=j.workspace_id and a.job_id=j.id
         and a.qc->'shot'->>'sourceMediaId' is not null
         and not exists(select 1 from available_sources s where s.workspace_id=j.workspace_id and s.product_id=j.product_id and s.r2_key=a.qc->'shot'->>'sourceMediaId'))) as source_available
      from generation_jobs j where j.id=${jobId}::uuid and j.workspace_id=${actor.workspaceId}::uuid`))[0];
    if (!job) return null;
    const found = rows<CaseRow>(await this.db.execute(sql`select ${publicColumns} from pack_cases c where c.workspace_id=${actor.workspaceId}::uuid and c.job_id=${jobId}::uuid
      and (c.reporter_user_id=${actor.userId}::uuid or ${role === "owner" || role === "admin"}) order by c.updated_at desc, c.id desc limit ${packCasesPolicy.casePageSize}`));
    return { cases: await Promise.all(found.map((row) => project(this.db, row, this.now()))), sourceUnavailable: !job.source_available };
  }
  async create(actor: CaseActor, jobId: string, raw: CreateCaseInput, supportRequestId?: string) {
    const input = createCaseInput.parse(raw);
    if (!isUuid(jobId) || (supportRequestId && supportRequestId !== input.requestId)) throw missing();
    return this.db.transaction(async (tx) => {
      const role = await membership(tx, actor);
      if (!role) throw missing();
      // All create/reopen operations share the job lock, so concurrent categories and retries cannot race.
      if (!rows(await tx.execute(sql`select id from generation_jobs where id=${jobId}::uuid and workspace_id=${actor.workspaceId}::uuid for update`)).length) throw missing();
      const replay = rows<CaseRow>(await tx.execute(sql`select ${publicColumns} from pack_cases c where c.workspace_id=${actor.workspaceId}::uuid and c.reporter_user_id=${actor.userId}::uuid and c.request_id=${input.requestId}::uuid`))[0];
      if (replay) {
        if (replay.job_id !== jobId || replay.category !== input.category || replay.description !== input.description || replay.shot_id !== (input.shotId ?? null) || replay.version_id !== (input.versionId ?? null)) throw new CaseRefusal("request_reused", "This request was already used. Reload and try again.");
        return { case: await project(tx, replay, this.now()), created: false };
      }
      const open = rows<CaseRow>(await tx.execute(sql`select ${publicColumns} from pack_cases c where c.workspace_id=${actor.workspaceId}::uuid and c.job_id=${jobId}::uuid and c.category=${input.category} and c.status <> 'resolved'`))[0];
      if (open) {
        if (!visible(open, actor, role)) throw new CaseRefusal("open_case", "There is already an open case for this pack and category. Ask a workspace owner for help.");
        return { case: await project(tx, open, this.now()), created: false };
      }
      if (input.shotId && !rows(await tx.execute(sql`select 1 from job_steps where workspace_id=${actor.workspaceId}::uuid and job_id=${jobId}::uuid and shot_id=${input.shotId}
        union all select 1 from assets where workspace_id=${actor.workspaceId}::uuid and job_id=${jobId}::uuid and qc->>'shotId'=${input.shotId} limit 1`)).length) throw new CaseRefusal("invalid_reference", "Choose a shot from this pack.");
      if (input.versionId && !rows(await tx.execute(sql`select 1 from asset_variants v join assets a on a.id=v.asset_id where v.id=${input.versionId}::uuid and v.workspace_id=${actor.workspaceId}::uuid and a.workspace_id=${actor.workspaceId}::uuid and a.job_id=${jobId}::uuid ${input.shotId ? sql`and a.qc->>'shotId'=${input.shotId}` : sql``}`)).length) throw new CaseRefusal("invalid_reference", "Choose an output file from this pack.");
      const feedback = rows<{ id: string }>(await tx.execute(sql`select id from pack_feedback where workspace_id=${actor.workspaceId}::uuid and job_id=${jobId}::uuid and user_id=${actor.userId}::uuid`))[0];
      const inserted = rows<{ id: string }>(await tx.execute(sql`insert into pack_cases(workspace_id,job_id,reporter_user_id,category,description,shot_id,version_id,feedback_id,source_support_request_id,request_id)
        values(${actor.workspaceId}::uuid,${jobId}::uuid,${actor.userId}::uuid,${input.category},${input.description},${input.shotId ?? null},${input.versionId ?? null}::uuid,${feedback?.id ?? null}::uuid,${supportRequestId ?? null}::uuid,${input.requestId}::uuid) returning id`))[0]!;
      const row = rows<CaseRow>(await tx.execute(sql`select ${publicColumns} from pack_cases c where c.id=${inserted.id}::uuid`))[0]!;
      await addEvent(tx, row, actor.userId, "seller", input.requestId, input.description, "received");
      return { case: await project(tx, row, this.now()), created: true };
    });
  }
  async reply(actor: CaseActor, jobId: string, caseId: string, raw: ReplyCaseInput) {
    const input = replyCaseInput.parse(raw);
    if (!isUuid(jobId) || !isUuid(caseId)) throw missing();
    return this.db.transaction(async (tx) => {
      const role = await membership(tx, actor);
      if (!role) throw missing();
      await tx.execute(sql`select id from generation_jobs where id=${jobId}::uuid and workspace_id=${actor.workspaceId}::uuid for update`);
      const row = rows<CaseRow>(await tx.execute(sql`select ${publicColumns} from pack_cases c where c.id=${caseId}::uuid and c.workspace_id=${actor.workspaceId}::uuid and c.job_id=${jobId}::uuid for update`))[0];
      if (!row || !visible(row, actor, role)) throw missing();
      const prior = rows<{ message: string; actor_user_id: string }>(await tx.execute(sql`select message,actor_user_id from pack_case_events where case_id=${caseId}::uuid and request_id=${input.requestId}::uuid`))[0];
      if (prior) {
        if (prior.message !== input.message || prior.actor_user_id !== actor.userId) throw new CaseRefusal("request_reused", "This request was already used. Reload and try again.");
        return project(tx, row, this.now());
      }
      if (row.status === "resolved") {
        if (!input.reopen) throw new CaseRefusal("resolved", "Choose Reopen case to add a new reply.");
        if (!canReopen(row.resolved_at, this.now())) throw new CaseRefusal("reopen_expired", "This case was resolved more than 30 days ago. Start a new case.");
        if (rows(await tx.execute(sql`select id from pack_cases where workspace_id=${actor.workspaceId}::uuid and job_id=${jobId}::uuid and category=${row.category} and status <> 'resolved'`)).length) throw new CaseRefusal("open_case", "There is already an open case for this category. Reply there instead.");
      }
      const status: CaseStatus = row.status === "resolved" || row.status === "awaiting_seller" ? "received" : row.status;
      await tx.execute(sql`update pack_cases set status=${status},resolved_at=null,updated_at=${this.now().toISOString()}::timestamptz where id=${caseId}::uuid`);
      await addEvent(tx, row, actor.userId, "seller", input.requestId, input.message, status === row.status ? null : status);
      return project(tx, { ...row, status, resolved_at: null, updated_at: this.now() }, this.now());
    });
  }
}
