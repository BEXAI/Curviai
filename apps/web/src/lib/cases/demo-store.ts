import { randomUUID } from "node:crypto";
import type { Services } from "@/lib/services/types";
import { canReopen, CaseRefusal, createCaseInput, replyCaseInput, type CaseActor, type CreateCaseInput, type PackCase, type ReplyCaseInput } from "./types";
import type { CaseStore } from "./store";

interface DemoRecord { workspaceId: string; reporterId: string; requestId: string; value: PackCase; replies: Map<string, string> }
export class DemoCaseState { readonly cases = new Map<string, DemoRecord>(); }
const scope = globalThis as typeof globalThis & { __curviDemoCases?: DemoCaseState };
export class DemoCaseStore implements CaseStore {
  constructor(private readonly services: Pick<Services, "getJob" | "getCurrentWorkspace" | "listJobFiles">, private readonly state = scope.__curviDemoCases ??= new DemoCaseState()) {}
  private async visible(actor: CaseActor, value: DemoRecord) {
    const workspace = await this.services.getCurrentWorkspace();
    return workspace?.id === actor.workspaceId && value.workspaceId === actor.workspaceId && (value.reporterId === actor.userId || workspace.role === "owner" || workspace.role === "admin");
  }
  async list(actor: CaseActor, jobId: string) {
    if (!await this.services.getJob(actor.workspaceId, jobId)) return null;
    const cases: PackCase[] = [];
    for (const record of this.state.cases.values()) if (record.value.jobId === jobId && await this.visible(actor, record)) cases.push(structuredClone(record.value));
    return { cases, sourceUnavailable: false };
  }
  async create(actor: CaseActor, jobId: string, raw: CreateCaseInput, supportRequestId?: string) {
    const input = createCaseInput.parse(raw);
    const job = await this.services.getJob(actor.workspaceId, jobId);
    if (!job) throw new CaseRefusal("not_found", "This pack is not available.");
    for (const record of this.state.cases.values()) {
      if (record.workspaceId !== actor.workspaceId) continue;
      const replay = record.reporterId === actor.userId && record.requestId === input.requestId;
      if (replay && (record.value.jobId !== jobId || record.value.description !== input.description || record.value.category !== input.category || record.value.shotId !== (input.shotId ?? null) || record.value.versionId !== (input.versionId ?? null))) throw new CaseRefusal("request_reused", "Reload and try again.");
      if (replay || (record.value.jobId === jobId && record.value.category === input.category && record.value.status !== "resolved")) {
        if (!await this.visible(actor, record)) throw new CaseRefusal("open_case", "Ask a workspace owner about the existing case.");
        return { case: structuredClone(record.value), created: false };
      }
    }
    if (input.shotId && !job.shots.some((shot) => shot.shotId === input.shotId)) throw new CaseRefusal("invalid_reference", "Choose a shot from this pack.");
    if (input.versionId && !(await this.services.listJobFiles(actor.workspaceId, jobId))?.files.some((file) => file.id === `v_${input.versionId}` && (!input.shotId || file.shotId === input.shotId))) throw new CaseRefusal("invalid_reference", "Choose an output file from this pack.");
    const at = new Date().toISOString();
    const value: PackCase = { id: randomUUID(), jobId, category: input.category, status: "received", description: input.description, shotId: input.shotId ?? null, versionId: input.versionId ?? null,
      feedbackLinked: false, supportLinked: Boolean(supportRequestId), createdAt: at, updatedAt: at, resolvedAt: null, canReopen: false,
      events: [{ id: randomUUID(), actor: "seller", status: "received", message: input.description, createdAt: at }] };
    this.state.cases.set(value.id, { workspaceId: actor.workspaceId, reporterId: actor.userId, requestId: input.requestId, value, replies: new Map() });
    return { case: structuredClone(value), created: true };
  }
  async reply(actor: CaseActor, jobId: string, caseId: string, raw: ReplyCaseInput) {
    const input = replyCaseInput.parse(raw), record = this.state.cases.get(caseId);
    if (!record || record.value.jobId !== jobId || !await this.visible(actor, record)) throw new CaseRefusal("not_found", "This case is not available.");
    const previous = record.replies.get(input.requestId);
    if (previous) {
      if (previous !== input.message) throw new CaseRefusal("request_reused", "Reload and try again.");
      return structuredClone(record.value);
    }
    if (record.value.status === "resolved") {
      if (!input.reopen) throw new CaseRefusal("resolved", "Choose Reopen case to add a new reply.");
      if (!canReopen(record.value.resolvedAt)) throw new CaseRefusal("reopen_expired", "Start a new case.");
      if ([...this.state.cases.values()].some((other) => other.workspaceId === actor.workspaceId && other.value.jobId === jobId && other.value.category === record.value.category && other.value.status !== "resolved")) throw new CaseRefusal("open_case", "Reply to the open case instead.");
    }
    if (record.value.status === "resolved" || record.value.status === "awaiting_seller") record.value.status = "received";
    record.value.resolvedAt = null; record.value.canReopen = false; record.value.updatedAt = new Date().toISOString();
    record.value.events.push({ id: randomUUID(), actor: "seller", status: record.value.status, message: input.message, createdAt: record.value.updatedAt });
    record.replies.set(input.requestId, input.message);
    return structuredClone(record.value);
  }
}
