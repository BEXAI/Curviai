/**
 * In memory cost meter. Records every attempt (ok and failed) and keeps
 * running cost totals per provider, per task, per jobId and per workspaceId,
 * plus LLM token totals per provider and per task (an LLM task is its
 * recipe key), with uncached input, cached input, output and reasoning
 * tokens kept apart (docs/phases/PHASE_17.md workstream 6).
 * Production uses a database backed CostMeter; this one backs tests, local
 * dev and short lived processes.
 */

import { emptyLlmUsage, type LlmUsage } from "./llm";
import type { CostMeter, CostMeterEntry } from "./types";

export interface WorkspaceTotals {
  costMicros: number;
  calls: number;
  byProvider: Record<string, number>;
  byTask: Record<string, number>;
}

/** LLM attempts that reported usage, their spend and their summed tokens. */
export interface LlmUsageTotals extends LlmUsage {
  calls: number;
  costMicros: number;
}

export function emptyLlmUsageTotals(): LlmUsageTotals {
  return { calls: 0, costMicros: 0, ...emptyLlmUsage() };
}

/** Adds one metered LLM attempt into running totals, in place. */
export function addLlmUsage(totals: LlmUsageTotals, entry: Pick<CostMeterEntry, "costMicros" | "usage">): void {
  totals.calls += 1;
  totals.costMicros += entry.costMicros;
  if (!entry.usage) return;
  totals.inputTokens += entry.usage.inputTokens;
  totals.cachedInputTokens += entry.usage.cachedInputTokens;
  totals.outputTokens += entry.usage.outputTokens;
  totals.reasoningTokens += entry.usage.reasoningTokens;
}

function bump(map: Map<string, number>, key: string, delta: number): void {
  map.set(key, (map.get(key) ?? 0) + delta);
}

function bumpLlm(map: Map<string, LlmUsageTotals>, key: string, entry: CostMeterEntry): void {
  const totals = map.get(key) ?? emptyLlmUsageTotals();
  addLlmUsage(totals, entry);
  map.set(key, totals);
}

export class InMemoryCostMeter implements CostMeter {
  readonly entries: CostMeterEntry[] = [];

  private readonly byProvider = new Map<string, number>();
  private readonly byTask = new Map<string, number>();
  private readonly byJob = new Map<string, number>();
  private readonly byWorkspace = new Map<string, number>();
  private readonly llmByProvider = new Map<string, LlmUsageTotals>();
  private readonly llmByTask = new Map<string, LlmUsageTotals>();

  record(entry: CostMeterEntry): void {
    this.entries.push(entry);
    bump(this.byProvider, entry.provider, entry.costMicros);
    bump(this.byTask, entry.task, entry.costMicros);
    if (entry.jobId) bump(this.byJob, entry.jobId, entry.costMicros);
    if (entry.workspaceId) bump(this.byWorkspace, entry.workspaceId, entry.costMicros);
    if (entry.usage) {
      bumpLlm(this.llmByProvider, entry.provider, entry);
      bumpLlm(this.llmByTask, entry.task, entry);
    }
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

  /** Token and spend totals of one provider's LLM attempts that reported usage. */
  llmUsageForProvider(provider: string): LlmUsageTotals {
    return { ...(this.llmByProvider.get(provider) ?? emptyLlmUsageTotals()) };
  }

  /** Token and spend totals of one LLM task (a recipe key). */
  llmUsageForTask(task: string): LlmUsageTotals {
    return { ...(this.llmByTask.get(task) ?? emptyLlmUsageTotals()) };
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
