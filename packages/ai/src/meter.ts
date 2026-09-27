/**
 * In memory cost meter. Records every attempt (ok and failed) and keeps
 * running cost totals per provider, per task, per jobId and per workspaceId.
 * Production uses a database backed CostMeter; this one backs tests, local
 * dev and short lived processes.
 */

import type { CostMeter, CostMeterEntry } from "./types";

export interface WorkspaceTotals {
  costMicros: number;
  calls: number;
  byProvider: Record<string, number>;
  byTask: Record<string, number>;
}

function bump(map: Map<string, number>, key: string, delta: number): void {
  map.set(key, (map.get(key) ?? 0) + delta);
}

export class InMemoryCostMeter implements CostMeter {
  readonly entries: CostMeterEntry[] = [];

  private readonly byProvider = new Map<string, number>();
  private readonly byTask = new Map<string, number>();
  private readonly byJob = new Map<string, number>();
  private readonly byWorkspace = new Map<string, number>();

  record(entry: CostMeterEntry): void {
    this.entries.push(entry);
    bump(this.byProvider, entry.provider, entry.costMicros);
    bump(this.byTask, entry.task, entry.costMicros);
    if (entry.jobId) bump(this.byJob, entry.jobId, entry.costMicros);
    if (entry.workspaceId) bump(this.byWorkspace, entry.workspaceId, entry.costMicros);
  }

  totalForProvider(provider: string): number {
    return this.byProvider.get(provider) ?? 0;
  }

  totalForTask(task: string): number {
    return this.byTask.get(task) ?? 0;
  }

  totalForJob(jobId: string): number {
    return this.byJob.get(jobId) ?? 0;
  }

  totalsFor(workspaceId: string): WorkspaceTotals {
    const totals: WorkspaceTotals = {
      costMicros: this.byWorkspace.get(workspaceId) ?? 0,
      calls: 0,
      byProvider: {},
      byTask: {},
    };
    for (const entry of this.entries) {
      if (entry.workspaceId !== workspaceId) continue;
      totals.calls += 1;
      totals.byProvider[entry.provider] = (totals.byProvider[entry.provider] ?? 0) + entry.costMicros;
      totals.byTask[entry.task] = (totals.byTask[entry.task] ?? 0) + entry.costMicros;
    }
    return totals;
  }
}
