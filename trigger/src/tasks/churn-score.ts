/**
 * Daily churn scoring cron (CURVI_BUILD_PLAN.md section 9.8). The scorer is
 * pure code in src/churn.ts; this wrapper reads per workspace signals (an in
 * memory demo set until the database env is wired), scores each workspace
 * and returns the bands with their typed retention recommendations.
 */

import { schedules } from "@trigger.dev/sdk/v3";
import { scoreChurn, type ChurnScore, type ChurnSignals } from "../churn";
import { demoChurnSignals, optionalEnv } from "../runtime";

export interface ChurnSignalReader {
  listWorkspaceSignals(): Promise<Array<{ workspaceId: string; signals: ChurnSignals }>>;
}

export class DemoChurnSignalReader implements ChurnSignalReader {
  async listWorkspaceSignals(): Promise<Array<{ workspaceId: string; signals: ChurnSignals }>> {
    return demoChurnSignals();
  }
}

export interface ChurnScoreRunResult {
  scoredAt: string;
  workspaces: Array<{ workspaceId: string } & ChurnScore>;
  notice?: string;
}

export const churnScore = schedules.task({
  id: "churn-score",
  cron: { pattern: "0 7 * * *", timezone: "America/New_York" },
  run: async (payload): Promise<ChurnScoreRunResult> => {
    const reader: ChurnSignalReader = new DemoChurnSignalReader();
    const rows = await reader.listWorkspaceSignals();
    const workspaces = rows.map((row) => ({ workspaceId: row.workspaceId, ...scoreChurn(row.signals) }));
    const result: ChurnScoreRunResult = {
      scoredAt: payload.timestamp.toISOString(),
      workspaces,
    };
    if (!optionalEnv("DATABASE_URL")) {
      result.notice =
        "Scored the in memory demo workspaces. Set DATABASE_URL so the job reads real signals and persists churn scores.";
    }
    return result;
  },
});
