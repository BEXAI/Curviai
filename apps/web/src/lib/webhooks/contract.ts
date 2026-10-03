export interface CompletionEvent {
  id: string;
  workspaceId: string;
  jobId: string;
  logicalRunId: string;
  outcome: "done" | "failed" | "canceled";
  packStatus: "done" | "failed" | "canceled";
  occurredAt: Date;
}
/** A terminal execution can fail while a pack from an earlier run remains
 * available. Neither field promises final credit settlement. */
export function completionBody(event: CompletionEvent): string {
  return JSON.stringify({
    id: event.id, type: "pack.run.terminal", version: 1,
    workspace_id: event.workspaceId, job_id: event.jobId, run_id: event.logicalRunId,
    outcome: event.outcome, pack_status: event.packStatus, occurred_at: event.occurredAt.toISOString(),
    pack_path: `/api/v1/packs/${event.jobId}`,
  });
}
