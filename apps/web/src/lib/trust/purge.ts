/**
 * 30 day source media purge (docs/PENDING.md, "Trust and platform"). Source
 * uploads are the seller's original photos and videos. Curvi keeps them only
 * while they are useful for packs: a source file older than 30 days is
 * deleted, from storage and from source_media, unless
 *
 * - its product had a pack created in the last 30 days (a pack is made from
 *   the product's stored photos, so those are what it references), or
 * - its product has a pack still running, whatever its age, or
 * - a share link shows it as the "before" image (the seller published it).
 *
 * Its mask object goes with it. Delivered pack files, which live under the
 * workspace's out prefix, are not touched.
 *
 * A second sweep removes orphan uploads: objects under ws/{id}/src/ older
 * than 30 days that no source_media row and no brand kit logo points at (a
 * photo uploaded to the new pack form and never used). It lists storage, so
 * it is bounded per run by maxOrphanObjects, and resumes where the last run
 * stopped (a cursor in platform_settings, key purge:orphan_cursor).
 *
 * Storage is deleted first and the row only once its objects are gone, so a
 * failed delete is retried on the next run instead of leaving an object no
 * row points at. Runs from the cron route
 * (apps/web/src/app/api/cron/purge-source-media/route.ts).
 */

import { platformSettings, sql, type Db } from "@curvi/db";
import { isWorkspaceObjectKey } from "@/lib/object-keys";
import type { TrustStorage } from "./storage";

export const SOURCE_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PurgeOptions {
  db: Db;
  storage: TrustStorage;
  now?: Date;
  /** Report what would be deleted, delete nothing. */
  dryRun?: boolean;
  /** Source rows handled per run. */
  maxRows?: number;
  /** Storage objects listed by the orphan sweep per run. */
  maxOrphanObjects?: number;
}

export interface PurgeReport {
  cutoff: string;
  dryRun: boolean;
  rowsMatched: number;
  rowsDeleted: number;
  objectsDeleted: number;
  objectsFailed: number;
  orphansDeleted: number;
}

interface StaleRow {
  id: string;
  workspace_id: string;
  r2_key: string;
  mask_r2_key: string | null;
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

export function purgeCutoff(now: Date): Date {
  return new Date(now.getTime() - SOURCE_RETENTION_DAYS * DAY_MS);
}

export async function purgeStaleSourceMedia(options: PurgeOptions): Promise<PurgeReport> {
  const { db, storage, dryRun = false } = options;
  const now = options.now ?? new Date();
  const cutoff = purgeCutoff(now);
  const maxRows = options.maxRows ?? 500;
  const report: PurgeReport = {
    cutoff: cutoff.toISOString(),
    dryRun,
    rowsMatched: 0,
    rowsDeleted: 0,
    objectsDeleted: 0,
    objectsFailed: 0,
    orphansDeleted: 0,
  };

  const stale = rowsOf<StaleRow>(
    await db.execute(sql`
      select sm.id, sm.workspace_id, sm.r2_key, sm.mask_r2_key
      from source_media sm
      where sm.created_at < ${cutoff.toISOString()}::timestamptz
        and not exists (
          select 1 from generation_jobs j
          where j.product_id = sm.product_id
            and (j.created_at >= ${cutoff.toISOString()}::timestamptz
                 or j.status not in ('done', 'failed', 'canceled'))
        )
        and not exists (select 1 from share_links s where s.before_media_id = sm.id)
      order by sm.created_at
      limit ${maxRows}
    `),
  );
  report.rowsMatched = stale.length;

  if (!dryRun && stale.length > 0) {
    // Only keys inside the row's own workspace are ever deleted; a legacy
    // row that points elsewhere loses its row but never another tenant's
    // object (Update.md 4.1).
    const keysOf = (row: StaleRow) =>
      [row.r2_key, row.mask_r2_key].filter((k): k is string => isWorkspaceObjectKey(row.workspace_id, k));
    const keys = [...new Set(stale.flatMap(keysOf))];
    const failed = new Set(keys.length > 0 ? await storage.deleteMany(keys) : []);
    report.objectsDeleted = keys.length - failed.size;
    report.objectsFailed = failed.size;
    const done = stale.filter((row) => keysOf(row).every((k) => !failed.has(k))).map((row) => row.id);
    if (done.length > 0) {
      await db.execute(sql`delete from source_media where id = any(${`{${done.join(",")}}`}::uuid[])`);
    }
    report.rowsDeleted = done.length;
  }

  report.orphansDeleted = await purgeOrphanUploads(db, storage, cutoff, dryRun, options.maxOrphanObjects ?? 5000, now);
  return report;
}

/** platform_settings key holding the last workspace the orphan sweep
 * finished, so the next run resumes after it. */
export const ORPHAN_CURSOR_KEY = "purge:orphan_cursor";

async function readOrphanCursor(db: Db): Promise<string | null> {
  const [row] = rowsOf<{ value: unknown }>(
    await db.execute(sql`select value from platform_settings where key = ${ORPHAN_CURSOR_KEY}`),
  );
  const value = row?.value as { workspaceId?: unknown } | null | undefined;
  const id = typeof value?.workspaceId === "string" ? value.workspaceId : null;
  return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

async function writeOrphanCursor(db: Db, workspaceId: string, at: Date): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key: ORPHAN_CURSOR_KEY, value: { workspaceId, at: at.toISOString() }, updatedAt: at })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
    });
}

/**
 * Deletes old objects under each workspace's source prefix that nothing
 * points at. Returns how many were deleted (or would be, on a dry run).
 *
 * The listing budget covers only part of a large bucket, so the sweep
 * resumes after the last workspace it finished (ORPHAN_CURSOR_KEY) and
 * wraps around to the first, instead of starting from the first workspace
 * every run and never reaching the rest. A workspace the budget cut short
 * is not counted as finished, so the next run lists it again; one that
 * alone is larger than the budget is passed over, so it cannot hold the
 * sweep in place. A dry run leaves the cursor where it was.
 */
async function purgeOrphanUploads(
  db: Db,
  storage: TrustStorage,
  cutoff: Date,
  dryRun: boolean,
  budget: number,
  now: Date,
): Promise<number> {
  const cursor = await readOrphanCursor(db);
  const workspaceRows = rowsOf<{ id: string }>(
    await db.execute(
      cursor
        ? sql`select id from workspaces order by (id <= ${cursor}::uuid), id`
        : sql`select id from workspaces order by id`,
    ),
  );
  let listed = 0;
  let deleted = 0;
  let finished: string | null = null;
  for (const [index, { id }] of workspaceRows.entries()) {
    if (listed >= budget) {
      break;
    }
    const allowance = budget - listed;
    const objects = await storage.list(`ws/${id}/src/`, allowance);
    listed += objects.length;
    if (objects.length < allowance || index === 0) {
      finished = id;
    }
    const old = objects.filter((o) => o.lastModified !== null && o.lastModified < cutoff);
    if (old.length === 0) {
      continue;
    }
    const referenced = new Set(
      rowsOf<{ key: string | null }>(
        await db.execute(sql`
          select r2_key as key from source_media where workspace_id = ${id}::uuid
          union all select mask_r2_key from source_media where workspace_id = ${id}::uuid
          union all select logo_r2_key from brand_kits where workspace_id = ${id}::uuid
        `),
      ).map((r) => r.key),
    );
    const orphans = old.map((o) => o.key).filter((key) => !referenced.has(key) && isWorkspaceObjectKey(id, key));
    if (orphans.length === 0) {
      continue;
    }
    if (dryRun) {
      deleted += orphans.length;
      continue;
    }
    const failed = await storage.deleteMany(orphans);
    deleted += orphans.length - failed.length;
  }
  if (!dryRun && finished) {
    try {
      await writeOrphanCursor(db, finished, now);
    } catch (err) {
      // The next run starts from the old cursor again; nothing is lost.
      console.warn("[purge] could not save the orphan sweep cursor", err instanceof Error ? err.message : err);
    }
  }
  return deleted;
}
