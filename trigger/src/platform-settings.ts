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
import { OPS_SWITCH_PREFIX, platformSettingSeedRows, type PlatformSettingSeedRow } from "@curvi/pipeline/seed";

/** Upserts the seeded platform settings. Idempotent; returns rows written.
 * A keepStored row (a runtime switch the founder flips by SQL, such as
 * acquisition_paused) is inserted only when missing, so a later seed never
 * resets the founder's choice; every other row is overwritten. */
export async function loadPlatformSettings(
  db: Db,
  rows: PlatformSettingSeedRow[] = platformSettingSeedRows,
): Promise<number> {
  // Operator switches live under ops: keys and only the founder writes them
  // (docs/phases/PHASE_20.md P20-20): a seeded ops: row would reset the
  // founder's choice on every release, so the loader refuses before writing.
  const opsRows = rows.filter((row) => row.key.trim().toLowerCase().startsWith(OPS_SWITCH_PREFIX));
  if (opsRows.length > 0) {
    throw new Error(
      `pnpm db:seed never writes operator switches; remove ${opsRows.map((row) => row.key).join(", ")} from the seed rows.`,
    );
  }
  if (rows.length === 0) {
    return 0;
  }
  const values = (list: PlatformSettingSeedRow[]) =>
    list.map((row) => ({ key: row.key, value: row.value, updatedAt: new Date() }));
  const overwrite = rows.filter((row) => !row.keepStored);
  const keep = rows.filter((row) => row.keepStored);
  if (overwrite.length > 0) {
    await db
      .insert(platformSettings)
      .values(values(overwrite))
      .onConflictDoUpdate({
        target: platformSettings.key,
        set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
      });
  }
  if (keep.length > 0) {
    await db.insert(platformSettings).values(values(keep)).onConflictDoNothing({ target: platformSettings.key });
  }
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
