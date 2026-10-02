import { eq, platformSettings, workspaces, type Db } from "@curvi/db";
import { costCaps, type TierKey } from "@curvi/pipeline/seed";

export function expectedDailyMicros(tier: string): number {
  return Object.hasOwn(costCaps.workspaceExpectedDailyMicrosByTier, tier) ? costCaps.workspaceExpectedDailyMicrosByTier[tier as TierKey] : costCaps.workspaceExpectedDailyMicrosByTier.free;
}

/** Invalid overrides cannot disable the seeded ceiling. Zero is a valid
 * emergency stop. The operator setting takes precedence over environment. */
export function resolveHardStopValue(setting: unknown, env: string | undefined): number {
  for (const candidate of [setting, env]) {
    if (candidate === null || candidate === undefined || candidate === "" || typeof candidate === "boolean") continue;
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return Math.round(value * 1_000_000);
  }
  return costCaps.globalDailyHardStopMicros;
}

export async function resolveGlobalHardStop(db: Pick<Db, "select">, env = process.env.DAILY_SPEND_HARD_STOP_USD): Promise<number> {
  const [row] = await db.select({ value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.key, "ops:global_hard_stop_usd"));
  return resolveHardStopValue(row?.value, env);
}
export async function workspaceExpectedDailyMicros(db: Pick<Db, "select">, workspaceId: string): Promise<number> {
  const [row] = await db.select({ plan: workspaces.plan }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return expectedDailyMicros(row?.plan ?? "free");
}
