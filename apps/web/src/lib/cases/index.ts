import { getServices, isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { getSessionUser } from "@/lib/supabase/server";
import { DbCaseStore } from "./db-store";
import { DemoCaseStore } from "./demo-store";
import type { CaseStore } from "./store";
export function getCaseStore(): CaseStore { return isDbMode() ? new DbCaseStore(getDb()) : new DemoCaseStore(getServices()); }
export async function caseActor(workspaceId: string) {
  const userId = isDbMode() ? (await getSessionUser())?.id : "demo";
  return userId ? { workspaceId, userId } : null;
}
