/**
 * Fresh Creative Drop cron: Mondays 08:00 America/New_York
 * (CURVI_BUILD_PLAN.md sections 3.2 and 8). The planning logic is pure and
 * injected from src/drops.ts; this wrapper reads workspaces (an in memory
 * demo roster until the database env is wired) and returns the computed
 * drop plans. Enqueueing real pack jobs from the plans lands with the app
 * database wiring.
 */

import { schedules } from "@trigger.dev/sdk/v3";
import { planWeeklyDrops, type DropWorkspace, type WeeklyDropResult } from "../drops";
import { demoDropWorkspaces, optionalEnv } from "../runtime";

export interface DropWorkspaceReader {
  listActiveWorkspaces(): Promise<DropWorkspace[]>;
}

export class DemoDropWorkspaceReader implements DropWorkspaceReader {
  async listActiveWorkspaces(): Promise<DropWorkspace[]> {
    return demoDropWorkspaces();
  }
}

export const weeklyDrop = schedules.task({
  id: "weekly-drop",
  cron: { pattern: "0 8 * * 1", timezone: "America/New_York" },
  run: async (payload): Promise<WeeklyDropResult & { notice?: string }> => {
    const reader: DropWorkspaceReader = new DemoDropWorkspaceReader();
    const workspaces = await reader.listActiveWorkspaces();
    const result = planWeeklyDrops(workspaces, { now: payload.timestamp });
    if (!optionalEnv("DATABASE_URL")) {
      return {
        ...result,
        notice:
          "Planned against the in memory demo workspace roster. Set DATABASE_URL so the drop reads real workspaces and enqueues packs.",
      };
    }
    return result;
  },
});
