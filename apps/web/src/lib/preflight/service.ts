/**
 * The preflight at upload, db mode (docs/phases/PHASE_14.md workstream 4).
 * One row per workspace and upload key in upload_preflights caches the
 * verdict: asking again for the same photo and note within
 * PREFLIGHT_FRESH_MS returns the row without any provider call. Otherwise
 * the runner side preflight runs through the worker's runtime deps (the same
 * recipes, @curvi/ai metering and caps, and the live runtime cutout a pack
 * uses), the chooser thumbnails go to the workspace's preflight prefix, and
 * the row is written with the spend added to cost_micros: booked on the
 * workspace as preflight spend, never charged in credits.
 */

import { createHash, randomUUID } from "node:crypto";
import { sql, uploadPreflights, type Db, type UploadPreflight } from "@curvi/db";
import type { UploadPreflightArgs, UploadPreflightRun } from "@curvi/trigger/preflight";
import { noteKey, PREFLIGHT_FRESH_MS, type PreflightIntake } from "@curvi/trigger/preflight-intake";
import { isWorkspaceKey } from "@/lib/r2";
import { preflightViewOf, storedPreflightOf, type StoredPreflight } from "./result";
import type { PreflightView } from "./types";

export interface PreflightServiceDeps {
  db: Db;
  /** Runs the runner side preflight; the worker runtime by default. */
  run?: (args: UploadPreflightArgs) => Promise<UploadPreflightRun>;
  /** Stores a thumbnail; null when storage is not configured. */
  putObject?: ((key: string, bytes: Buffer, contentType: string) => Promise<void>) | null;
  /** Signs a stored thumbnail for the form. */
  sign?: (key: string) => Promise<string | null>;
  now?: () => Date;
}

/** The worker runtime's preflight, loaded on first use like the inline
 * runner loads the pack runner. */
export async function defaultPreflightRun(args: UploadPreflightArgs): Promise<UploadPreflightRun> {
  const [{ resolveRuntimeDeps }, { runUploadPreflight }] = await Promise.all([
    import("@curvi/trigger/db-runtime"),
    import("@curvi/trigger/preflight"),
  ]);
  return runUploadPreflight(resolveRuntimeDeps(), args);
}

/** Where a preflight's thumbnails live: under the workspace's prefix, so
 * deleting the workspace's storage deletes them. */
export function preflightThumbKey(workspaceId: string, uploadKey: string, preflightId: string, number: number): string {
  const upload = createHash("sha256").update(uploadKey).digest("hex").slice(0, 32);
  return `ws/${workspaceId}/preflight/${upload}/${preflightId}-${number}.jpg`;
}

function isFresh(row: Pick<UploadPreflight, "updatedAt">, now: Date): boolean {
  const age = now.getTime() - row.updatedAt.getTime();
  return age >= 0 && age < PREFLIGHT_FRESH_MS;
}

/** The cached rows of these uploads in this workspace, by key. */
export async function preflightRowsFor(db: Db, workspaceId: string, keys: readonly string[]): Promise<Map<string, UploadPreflight>> {
  if (keys.length === 0) {
    return new Map();
  }
  const rows = await db.query.uploadPreflights.findMany({
    where: (t, { and, eq, inArray }) => and(eq(t.workspaceId, workspaceId), inArray(t.r2Key, [...keys])),
  });
  return new Map(rows.map((row) => [row.r2Key, row]));
}

/** The stored intake answer a pack may reuse, when the row is fresh. The
 * runner checks the note and the recipe version again before using it. */
export function reusableIntakeOf(row: UploadPreflight | undefined, now: Date): PreflightIntake | undefined {
  if (!row || !row.intake || !isFresh(row, now)) {
    return undefined;
  }
  return row.intake as unknown as PreflightIntake;
}

/**
 * The product box the preflight kept for an upload (upload_preflights.result
 * productBox), for the P1 crop fit, or undefined when the row has none or
 * holds anything but a box inside the photo. Any age: the box describes the
 * stored photo, which never changes.
 */
export function preflightProductBoxOf(
  row: UploadPreflight | undefined,
): { x: number; y: number; width: number; height: number } | undefined {
  const box = (row?.result as { productBox?: unknown } | null | undefined)?.productBox;
  if (!box || typeof box !== "object") {
    return undefined;
  }
  const { x, y, width, height } = box as Record<string, unknown>;
  const numbers = [x, y, width, height];
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return undefined;
  }
  const [bx, by, bw, bh] = numbers as number[];
  const inside = bx >= 0 && by >= 0 && bw > 0 && bh > 0 && bx + bw <= 1.0001 && by + bh <= 1.0001;
  return inside ? { x: bx, y: by, width: bw, height: bh } : undefined;
}

export async function preflightUpload(
  deps: PreflightServiceDeps,
  workspaceId: string,
  input: { key: string; note?: string | null },
): Promise<PreflightView> {
  const now = deps.now?.() ?? new Date();
  const note = input.note?.trim() ?? "";
  const sign = async (key: string) =>
    isWorkspaceKey(workspaceId, key) && deps.sign ? deps.sign(key) : null;
  const cached = (await preflightRowsFor(deps.db, workspaceId, [input.key])).get(input.key);
  if (cached && cached.status !== "unavailable" && cached.noteKey === noteKey(note) && isFresh(cached, now)) {
    return preflightViewOf(input.key, cached.result as unknown as StoredPreflight, sign);
  }

  const preflightId = randomUUID();
  const run = await (deps.run ?? defaultPreflightRun)({ preflightId, workspaceId, mediaKey: input.key, note, now });
  const thumbKeys: Array<string | null> = [];
  if (run.thumbnails.length > 0 && deps.putObject) {
    for (const [i, bytes] of run.thumbnails.entries()) {
      const key = preflightThumbKey(workspaceId, input.key, preflightId, i + 1);
      try {
        await deps.putObject(key, bytes, "image/jpeg");
        thumbKeys.push(key);
      } catch (err) {
        console.warn(`[preflight] could not store a chooser thumbnail for workspace ${workspaceId}`, err);
        thumbKeys.push(null);
      }
    }
  }
  const stored = storedPreflightOf(run, thumbKeys);
  const values = {
    noteKey: noteKey(note),
    status: stored.status,
    result: stored as unknown as Record<string, unknown>,
    intake: run.intake ? (run.intake as unknown as Record<string, unknown>) : null,
  };
  await deps.db
    .insert(uploadPreflights)
    .values({ workspaceId, r2Key: input.key, ...values, costMicros: run.costMicros })
    .onConflictDoUpdate({
      target: [uploadPreflights.workspaceId, uploadPreflights.r2Key],
      set: {
        ...values,
        // Every run's provider spend stays booked on the workspace.
        costMicros: sql`${uploadPreflights.costMicros} + ${run.costMicros}`,
        updatedAt: now,
      },
    });
  if (run.costMicros > 0) {
    console.info(
      JSON.stringify({ event: "preflight_spend", workspaceId, preflightId, costMicros: run.costMicros, status: stored.status }),
    );
  }
  return preflightViewOf(input.key, stored, sign);
}
