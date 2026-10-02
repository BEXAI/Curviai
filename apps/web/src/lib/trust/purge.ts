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
 * A durable retirement marker prevents any new reference before deletion.
 * Storage is deleted first and the row only once its objects are gone, so a
 * failed delete is retried on the next run instead of leaving an object no
 * row points at. Runs from the cron route
 * (apps/web/src/app/api/cron/purge-source-media/route.ts).
 */

import { platformSettings, sql, type Db } from "@curvi/db";
import { isWorkspaceObjectKey } from "@/lib/object-keys";
import type { PagedTrustStorage } from "./storage";
import { retireSourceKeys, type SourceTransaction } from "./source-retention";

export const SOURCE_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PurgeOptions {
  db: Db;
  storage: PagedTrustStorage;
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

/** Persisted active runs can reference legacy uploads from another product.
 * Preserve those exact keys as well as the product-level retention window. */
function activePayloadKeys(workspaceId: ReturnType<typeof sql>) {
  return sql`select reference.key from generation_jobs job cross join lateral (
    select job.restart_payload -> 'brand' ->> 'logoKey' as key
    union all select image ->> 'mediaId' from jsonb_array_elements(
      case when jsonb_typeof(job.restart_payload -> 'images') = 'array'
        then job.restart_payload -> 'images' else '[]'::jsonb end) image
    union all select shot ->> 'sourceMediaId' from jsonb_array_elements(
      case when jsonb_typeof(job.restart_payload -> 'shots') = 'array'
        then job.restart_payload -> 'shots' else '[]'::jsonb end) shot
  ) reference where job.workspace_id = ${workspaceId} and job.status not in ('done', 'failed', 'canceled')`;
}

/** A committed retirement remains eligible even if another pack later uses
 * different photos of this product. Its old keys cannot gain new references. */
async function staleRows(db: Pick<Db, "execute"> | SourceTransaction, cutoff: Date, limit: number, ids?: string[]): Promise<StaleRow[]> {
  return rowsOf<StaleRow>(await db.execute(sql`
    select sm.id, sm.workspace_id, sm.r2_key, sm.mask_r2_key
    from source_media sm
    where ${ids ? sql`sm.id = any(${`{${ids.join(",")}}`}::uuid[]) and` : sql``}
      (exists (select 1 from retired_source_objects retired where retired.workspace_id = sm.workspace_id
        and retired.r2_key = sm.r2_key)
      or (sm.created_at < ${cutoff.toISOString()}::timestamptz
        and not exists (
          select 1 from generation_jobs j where j.product_id = sm.product_id
            and (greatest(j.created_at, coalesce(j.started_at, j.created_at)) >= ${cutoff.toISOString()}::timestamptz
                 or j.status not in ('done', 'failed', 'canceled'))
        )
        and not exists (select 1 from share_links s where s.before_media_id = sm.id)
        and not exists (select 1 from brand_kits b where b.workspace_id = sm.workspace_id
          and b.logo_r2_key in (sm.r2_key, sm.mask_r2_key))
        and not exists (select 1 from (${activePayloadKeys(sql`sm.workspace_id`)}) reference
          where reference.key in (sm.r2_key, sm.mask_r2_key))))
    order by sm.created_at, sm.id limit ${limit}
  `));
}

export async function purgeStaleSourceMedia(options: PurgeOptions): Promise<PurgeReport> {
  const { db, storage, dryRun = false } = options;
  const now = options.now ?? new Date();
  const cutoff = purgeCutoff(now);
  const maxRows = options.maxRows ?? 500;
  const report: PurgeReport = {
    cutoff: cutoff.toISOString(), dryRun, rowsMatched: 0, rowsDeleted: 0,
    objectsDeleted: 0, objectsFailed: 0, orphansDeleted: 0,
  };
  const stale = await staleRows(db, cutoff, maxRows);
  report.rowsMatched = stale.length;
  const keysOf = (row: StaleRow) =>
    [row.r2_key, row.mask_r2_key].filter((key): key is string => isWorkspaceObjectKey(row.workspace_id, key));

  if (!dryRun) {
    const byWorkspace = new Map<string, StaleRow[]>();
    for (const row of stale) byWorkspace.set(row.workspace_id, [...(byWorkspace.get(row.workspace_id) ?? []), row]);
    for (const [workspaceId, candidates] of byWorkspace) {
      // Selection outside the lock is only a hint. Recheck current references
      // under the same lock every reference writer takes, then durably retire
      // the keys before sending an irreversible storage request.
      const retiring = await db.transaction(async (tx) => {
        await tx.execute(sql`select 1 from workspaces where id = ${workspaceId}::uuid for update`);
        const current = await staleRows(tx, cutoff, candidates.length, candidates.map((row) => row.id));
        // A legacy alias may also be another row's source or mask. Remove
        // only this row's ownership, leaving the shared object to its owner.
        const otherReferences = new Set(current.length === 0 ? [] : rowsOf<{ key: string | null }>(await tx.execute(sql`
          select r2_key as key from source_media where workspace_id = ${workspaceId}::uuid
            and not (id = any(${`{${current.map((row) => row.id).join(",")}}`}::uuid[]))
          union all select mask_r2_key from source_media where workspace_id = ${workspaceId}::uuid
            and not (id = any(${`{${current.map((row) => row.id).join(",")}}`}::uuid[]))
        `)).map((row) => row.key));
        const planned = current.map((row) => ({ ...row, deleteKeys: keysOf(row).filter((key) => !otherReferences.has(key)) }));
        await retireSourceKeys(tx, workspaceId, planned.flatMap((row) => row.deleteKeys));
        return planned;
      });
      const keys = [...new Set(retiring.flatMap((row) => row.deleteKeys))];
      const failed = new Set(keys.length > 0 ? await storage.deleteMany(keys) : []);
      report.objectsDeleted += keys.length - failed.size;
      report.objectsFailed += failed.size;
      const done = retiring.filter((row) => row.deleteKeys.every((key) => !failed.has(key))).map((row) => row.id);
      if (done.length > 0) {
        await db.transaction(async (tx) => {
          await tx.execute(sql`select 1 from workspaces where id = ${workspaceId}::uuid for update`);
          // A shared original was deliberately left unretired. It may have
          // gained a pack/share reference while other objects were deleted.
          const removable = await staleRows(tx, cutoff, done.length, done);
          if (removable.length) await tx.execute(sql`delete from source_media where workspace_id = ${workspaceId}::uuid
            and id = any(${`{${removable.map((row) => row.id).join(",")}}`}::uuid[])`);
          report.rowsDeleted += removable.length;
        });
      }
    }
  }
  report.orphansDeleted = await purgeOrphanUploads(db, storage, cutoff, dryRun, options.maxOrphanObjects ?? 5000, now);
  return report;
}

/** The last completed workspace, or a page within an unfinished workspace. */
export const ORPHAN_CURSOR_KEY = "purge:orphan_cursor";

interface OrphanCursor {
  workspaceId: string;
  inProgress: boolean;
  continuationToken: string | null;
}

async function readOrphanCursor(db: Db): Promise<OrphanCursor | null> {
  const [row] = rowsOf<{ value: unknown }>(
    await db.execute(sql`select value from platform_settings where key = ${ORPHAN_CURSOR_KEY}`),
  );
  const value = row?.value as { workspaceId?: unknown; inProgress?: unknown; continuationToken?: unknown } | null | undefined;
  const id = typeof value?.workspaceId === "string" ? value.workspaceId : null;
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  return {
    workspaceId: id,
    inProgress: value?.inProgress === true,
    continuationToken: typeof value?.continuationToken === "string" ? value.continuationToken : null,
  };
}

async function writeOrphanCursor(db: Db, cursor: OrphanCursor, at: Date): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key: ORPHAN_CURSOR_KEY, value: { ...cursor, at: at.toISOString() }, updatedAt: at })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
    });
}

/** A page cursor is saved only after every deletion in that page succeeds.
 * A failed page is retried from its start. Partial workspaces resume within
 * their prefix, including when an entire run listed only protected objects.
 * Old workspace-only cursors still mean that workspace was completed.
 */
async function purgeOrphanUploads(
  db: Db,
  storage: PagedTrustStorage,
  cutoff: Date,
  dryRun: boolean,
  budget: number,
  now: Date,
): Promise<number> {
  const cursor = await readOrphanCursor(db);
  const workspaceRows = rowsOf<{ id: string }>(
    await db.execute(
      cursor
        ? cursor.inProgress
          ? sql`select id from workspaces order by (id < ${cursor.workspaceId}::uuid), id`
          : sql`select id from workspaces order by (id <= ${cursor.workspaceId}::uuid), id`
        : sql`select id from workspaces order by id`,
    ),
  );
  let listed = 0;
  let deleted = 0;
  let next: OrphanCursor | null = null;
  sweep: for (const { id } of workspaceRows) {
    if (listed >= budget) break;
    let token = cursor?.inProgress && cursor.workspaceId === id ? cursor.continuationToken : null;
    do {
      // The page is bounded (at most 1000 objects). Both the listing and
      // reference recheck happen while holding the workspace lock, so a
      // copied/registered source or newly saved logo cannot appear between
      // the snapshot and the retirement commit.
      const { page, orphans } = await db.transaction(async (tx) => {
        await tx.execute(sql`select 1 from workspaces where id = ${id}::uuid for update`);
        const page = await storage.listPage(`ws/${id}/src/`, budget - listed, token);
        if (page.continuationToken && page.continuationToken === token) throw new Error("Storage cursor did not advance");
        const retired = new Set(rowsOf<{ key: string }>(await tx.execute(sql`
          select r2_key as key from retired_source_objects where workspace_id = ${id}::uuid
            and r2_key in (select jsonb_array_elements_text(${JSON.stringify(page.objects.map((object) => object.key))}::jsonb))
        `)).map((row) => row.key));
        // A copy may finish after a previous delete succeeded. Its permanent
        // marker keeps it unreferenceable, and we remove it again even young.
        const old = page.objects.filter((o) => retired.has(o.key) || (o.lastModified !== null && o.lastModified < cutoff));
        const referenced = new Set(old.length === 0 ? [] : rowsOf<{ key: string | null }>(
          await tx.execute(sql`
            select r2_key as key from source_media where workspace_id = ${id}::uuid
            union all select mask_r2_key from source_media where workspace_id = ${id}::uuid
            union all select logo_r2_key from brand_kits where workspace_id = ${id}::uuid
            union all ${activePayloadKeys(sql`${id}::uuid`)}
          `),
        ).map((row) => row.key));
        const orphans = old.map((object) => object.key).filter((key) => !referenced.has(key) && isWorkspaceObjectKey(id, key));
        if (!dryRun) await retireSourceKeys(tx, id, orphans);
        return { page, orphans };
      });
      listed += page.objects.length;
      const failed = !dryRun && orphans.length > 0 ? await storage.deleteMany(orphans) : [];
      deleted += orphans.length - failed.length;
      if (failed.length > 0) {
        next = { workspaceId: id, inProgress: true, continuationToken: token };
        break sweep;
      }
      next = { workspaceId: id, inProgress: page.continuationToken !== null, continuationToken: page.continuationToken };
      token = page.continuationToken;
    } while (token && listed < budget);
  }
  if (!dryRun && next) {
    try {
      await writeOrphanCursor(db, next, now);
    } catch (err) {
      // The next run starts from the old cursor again; nothing is lost.
      console.warn("[purge] could not save the orphan sweep cursor", err instanceof Error ? err.message : err);
    }
  }
  return deleted;
}
