/**
 * Platform settings seeding (migration 0012). pnpm db:seed upserts the rows
 * from packages/pipeline seed data into platform_settings, where database
 * functions read them directly: grant_signup_credits pays the free tier's one
 * time grant from free_signup_credits (CLAUDE.md rule 2, Update.md 1.9).
 * After seeding, grant_pending_signup_credits settles every confirmed user
 * who could not be paid earlier, for example because the setting was not
 * seeded yet when they confirmed.
 */

import { platformSettings, sql, type Db } from "@curvi/db";
import { platformSettingSeedRows, type PlatformSettingSeedRow } from "@curvi/pipeline/seed";

/** Upserts the seeded platform settings. Idempotent; returns rows written. */
export async function loadPlatformSettings(
  db: Db,
  rows: PlatformSettingSeedRow[] = platformSettingSeedRows,
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  await db
    .insert(platformSettings)
    .values(rows.map((row) => ({ key: row.key, value: row.value, updatedAt: new Date() })))
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
    });
  return rows.length;
}

type PendingRow = { settled: string | number | null };

/** postgres-js returns the rows array; PGlite (tests) returns { rows }. */
function rowsOf(result: unknown): PendingRow[] {
  if (Array.isArray(result)) {
    return result as PendingRow[];
  }
  return ((result as { rows?: PendingRow[] }).rows ?? []) as PendingRow[];
}

/** Settles the signup grant of every confirmed user who has none yet.
 * Returns how many users were settled (paid or withheld). */
export async function grantPendingSignupCredits(db: Db): Promise<number> {
  const rows = rowsOf(await db.execute(sql`select grant_pending_signup_credits() as settled`));
  return Number(rows[0]?.settled ?? 0);
}
