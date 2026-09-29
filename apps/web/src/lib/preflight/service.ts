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
import { resolveSellerAnswers, SellerQuestion, type SellerAnswers } from "@curvi/pipeline/questions";
import { channelChoices, moodChoices, questionSet } from "@curvi/pipeline/seed";
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

/**
 * Where a preflight's cutout preview lives (PHASE_15 P1): the workspace's
 * cache prefix next to the cutout cache (ws/{id}/cache/cutout/). One object
 * per upload, written over by every re-check, since the upload's single
 * preflight row only ever points at the latest preview; so re-checks never
 * pile up objects, and deleting the workspace's storage (ws/{id}/) deletes
 * it. The form reads it through a signed url only while the preflight row
 * is fresh, like the cutout the pack reuses.
 */
export function preflightPreviewKey(workspaceId: string, uploadKey: string): string {
  const upload = createHash("sha256").update(uploadKey).digest("hex").slice(0, 32);
  return `ws/${workspaceId}/cache/preview/${upload}.png`;
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

/**
 * The questions the preflight asked about an upload (upload_preflights.result
 * questions, PHASE_16 workstream 4), each read with the shared schema; an
 * entry out of shape is left out. Any age: the seller answered the questions
 * the form showed, which are the row's latest.
 */
export function preflightQuestionsOf(row: UploadPreflight | undefined): SellerQuestion[] {
  if (!row || row.status === "blocked" || row.status === "unavailable") {
    return [];
  }
  const raw = (row.result as { questions?: unknown } | null | undefined)?.questions;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    const parsed = SellerQuestion.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * The seller's answers for a pack (generation_jobs.seller_answers): the taps
 * sent with the pack, resolved against the questions stored for the upload
 * they were asked about. The upload must be one of the pack's photos; a tap
 * that matches no stored option is dropped, so every label is the server's.
 * Null when nothing is left, which is also a skipped step.
 */
export function sellerAnswersFor(
  preflights: ReadonlyMap<string, UploadPreflight>,
  packKeys: readonly string[],
  sent: { key: string; picks: Record<string, string> } | undefined,
): SellerAnswers | null {
  if (!sent || !packKeys.includes(sent.key)) {
    return null;
  }
  return resolveSellerAnswers(preflightQuestionsOf(preflights.get(sent.key)), sent.picks);
}

/**
 * The questions a caller with no upload preflight may answer (the v1 API
 * and MCP): channels and mood, each offering every seed choice, so any
 * seed value resolves. Target, use and audience need the photo's inventory
 * or model written options and are never offered here.
 */
export function choiceQuestions(): SellerQuestion[] {
  return [
    {
      id: "channels",
      kind: "channels",
      options: [
        ...channelChoices.map((c) => ({ value: c.value, label: c.label })),
        { value: questionSet.allOption.value, label: questionSet.allOption.manyLabel },
      ],
    },
    { id: "mood", kind: "mood", options: moodChoices.map((m) => ({ value: m.value, label: m.label })) },
  ];
}

/** Answers sent by value with no preflight, resolved against choiceQuestions. */
export function sellerAnswersFromChoices(sent: { channels?: string; mood?: string } | undefined): SellerAnswers | null {
  if (!sent) {
    return null;
  }
  const picks: Record<string, string> = {};
  if (sent.channels !== undefined) picks.channels = sent.channels;
  if (sent.mood !== undefined) picks.mood = sent.mood;
  return resolveSellerAnswers(choiceQuestions(), picks);
}

/**
 * True when the preflight's intake saw text, borders, watermarks or stickers
 * added on top of the upload (upload_preflights.result addedOverlays, intake
 * version 5). Any age: the verdict describes the stored photo, which never
 * changes. False for a row without the flag (a clean photo, or an older
 * intake), null when there is no usable row to read.
 */
export function preflightAddedOverlaysOf(row: UploadPreflight | undefined): boolean | null {
  if (!row || row.status === "unavailable") {
    return null;
  }
  return (row.result as { addedOverlays?: unknown } | null | undefined)?.addedOverlays === true;
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
  let previewKey: string | null = null;
  if (run.preview && deps.putObject) {
    const key = preflightPreviewKey(workspaceId, input.key);
    try {
      await deps.putObject(key, run.preview, "image/png");
      previewKey = key;
    } catch (err) {
      console.warn(`[preflight] could not store a cutout preview for workspace ${workspaceId}`, err);
    }
  }
  const stored = storedPreflightOf(run, thumbKeys, previewKey);
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
