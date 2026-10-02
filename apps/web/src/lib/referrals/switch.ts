/**
 * The ops:referrals_enabled switch (docs/phases/PHASE_18.md P18-24), off by default
 * until founder decision 18. Read per process at most once per seeded
 * switchCacheSeconds, and fails closed: a missing row, any value but a
 * stored true, demo mode or a failed read all mean off.
 */

import { referralCodePolicy, REFERRALS_SETTING } from "@curvi/pipeline/seed";
import { sql, type Db } from "@curvi/db";

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] } | null)?.rows ?? [])) as T[];
}

/** The stored switch. Compared in SQL, so a JSON string "true" stays off. */
export async function readReferralsSwitch(db: Pick<Db, "execute">): Promise<boolean> {
  const rows = rowsOf<{ on: unknown }>(
    await db.execute(sql`select value = 'true'::jsonb as on from platform_settings where key = ${REFERRALS_SETTING}`),
  );
  return rows[0]?.on === true;
}

const scope = globalThis as typeof globalThis & { __curviReferralsSwitch?: { on: boolean; at: number } };

async function defaultRead(): Promise<boolean> {
  const { isDbMode } = await import("@/lib/services");
  if (!isDbMode()) {
    return false;
  }
  const { getDb } = await import("@/lib/services/db");
  return readReferralsSwitch(getDb());
}

/** Whether referral codes, signups and rewards are on. Never throws. */
export async function referralsOn(
  deps: { read?: () => Promise<boolean>; now?: () => number; fresh?: boolean } = {},
): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const cached = scope.__curviReferralsSwitch;
  if (!deps.fresh && cached && now() - cached.at < referralCodePolicy.switchCacheSeconds * 1000) {
    return cached.on;
  }
  let on = false;
  try {
    on = (await (deps.read ?? defaultRead)()) === true;
  } catch (err) {
    console.warn("[referrals] could not read ops:referrals_enabled; treating it as off", err);
  }
  scope.__curviReferralsSwitch = { on, at: now() };
  return on;
}

/** Forgets the cached switch (tests). */
export function resetReferralsSwitchForTests(): void {
  delete scope.__curviReferralsSwitch;
}
