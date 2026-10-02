/**
 * The free white main image before signup, web side (docs/phases/PHASE_18.md
 * P18-12). Server only. The route checks the gates and the per IP cap; this
 * takes a site wide slot, ingests the photo, runs the runner side preview
 * (@curvi/trigger/free-preview: intake, moderation, the cutout, the pack's
 * renderer and checks, all through @curvi/ai), stores the files under
 * anon/preview/{id}/ in R2, books the spend on today's preview key and
 * answers with a small preview, the measured checks and the fidelity
 * numbers. The full size file needs an email; a claim at signup moves the
 * photo and its cutout into the new workspace (./claim.ts).
 */

import { createHash } from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { CapStore } from "@curvi/ai";
import { eq, freePreviews, recordFunnelEvent, type Db, type FreePreview, type FreePreviewStatus } from "@curvi/db";
import { IMAGE_INGEST_MESSAGES, ingestImage, type IngestImageFormat } from "@curvi/pipeline/ingest";
import { freePreview } from "@curvi/pipeline/seed";
import type { FreePreviewArgs, FreePreviewRun } from "@curvi/trigger/free-preview";
import { attachmentDisposition, getObjectBytes, privateBucket, putGeneratedObject, r2Client } from "@/lib/r2";
import type { LeadStore } from "@/lib/leads";
import { FREE_PREVIEW_COPY } from "./copy";
import { bookPreviewSpend, previewIpHash, releasePreviewSlot, reservePreviewSlot } from "./gate";

/** Where a preview's files live in R2 (the founder's lifecycle rule expires anon/). */
export const PREVIEW_PREFIX = "anon/preview/";

export type StoredFormat = "jpeg" | "png" | "webp";

export function extensionOf(format: StoredFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

export function contentTypeOf(format: StoredFormat): string {
  return `image/${format}`;
}

export function previewOriginalKey(id: string, format: StoredFormat): string {
  return `${PREVIEW_PREFIX}${id}/original.${extensionOf(format)}`;
}

export function previewCutoutKey(id: string): string {
  return `${PREVIEW_PREFIX}${id}/cutout.png`;
}

export function previewMainKey(id: string, format: "jpeg" | "png"): string {
  return `${PREVIEW_PREFIX}${id}/main.${extensionOf(format)}`;
}

/** The R2 calls a preview needs, injectable for tests. */
export interface PreviewStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  /** A signed GET that downloads as filename, valid for seconds. */
  signDownload(key: string, filename: string, seconds: number): Promise<string>;
}

export function r2PreviewStorage(): PreviewStorage {
  return {
    put: (key, body, contentType) => putGeneratedObject(key, body, contentType),
    get: (key) => getObjectBytes(key),
    signDownload: (key, filename, seconds) =>
      getSignedUrl(
        r2Client(),
        new GetObjectCommand({
          Bucket: privateBucket(),
          Key: key,
          ResponseContentDisposition: attachmentDisposition(filename),
        }),
        { expiresIn: seconds },
      ),
  };
}

export interface FreePreviewServiceDeps {
  db: Db;
  counters: CapStore;
  storage: PreviewStorage;
  run: (args: FreePreviewArgs) => Promise<FreePreviewRun>;
  now: () => Date;
}

/** The worker runtime's preview, loaded on first use like the preflight. */
export async function defaultFreePreviewRun(args: FreePreviewArgs): Promise<FreePreviewRun> {
  const [{ resolveRuntimeDeps }, { runFreePreview }] = await Promise.all([
    import("@curvi/trigger/db-runtime"),
    import("@curvi/trigger/free-preview"),
  ]);
  return runFreePreview(resolveRuntimeDeps(), args);
}

export interface PreviewCheckView {
  name: string;
  pass: boolean;
}

export interface PreviewFidelityView {
  meanDeltaE: number;
  maxDeltaE: number;
  exactByteShare: number;
}

export type CreatePreviewResult =
  | { kind: "daily_limit" }
  | { kind: "refused"; message: string }
  | {
      kind: "done";
      previewId: string;
      /** A data: URL of the small JPEG. */
      preview: string;
      checks: PreviewCheckView[];
      checksPass: boolean;
      fillPct: number | null;
      fidelity: PreviewFidelityView;
    }
  | { kind: "blocked" | "failed" | "unavailable"; previewId: string; message: string };

const MESSAGES = {
  blocked: FREE_PREVIEW_COPY.blocked,
  failed: FREE_PREVIEW_COPY.failed,
  unavailable: FREE_PREVIEW_COPY.unavailable,
} as const;

function storedFormatOf(format: IngestImageFormat): StoredFormat {
  // ingestImage writes GIF and TIFF as PNG, so the stored copy is one of these.
  return format === "jpeg" || format === "webp" ? format : "png";
}

async function finish(
  db: Db,
  id: string,
  values: { status: FreePreviewStatus; blockedReason?: string | null; costMicros: number; mainFormat?: "jpeg" | "png" | null },
): Promise<void> {
  await db
    .update(freePreviews)
    .set({
      status: values.status,
      blockedReason: values.blockedReason ? values.blockedReason.slice(0, 200) : null,
      costMicros: Math.max(0, Math.round(values.costMicros)),
      ...(values.mainFormat ? { mainFormat: values.mainFormat } : {}),
    })
    .where(eq(freePreviews.id, id));
}

/**
 * Makes one preview from an uploaded photo. The caller has already checked
 * the gates, the per IP cap, the size cap and the honeypot. Takes a site
 * wide slot first; a refused upload gives it back, anything that reached a
 * provider keeps it and books its spend.
 */
export async function createFreePreview(
  deps: FreePreviewServiceDeps,
  input: { bytes: Buffer; ip: string },
): Promise<CreatePreviewResult> {
  const now = deps.now();
  if (!(await reservePreviewSlot(deps.counters, now))) {
    return { kind: "daily_limit" };
  }
  const ingested = await ingestImage(input.bytes).catch(() => null);
  if (!ingested || !ingested.ok) {
    await releasePreviewSlot(deps.counters, now);
    return { kind: "refused", message: ingested ? IMAGE_INGEST_MESSAGES[ingested.reason] : FREE_PREVIEW_COPY.failed };
  }
  const sourceFormat = storedFormatOf(ingested.format);
  const [row] = await deps.db
    .insert(freePreviews)
    .values({
      ipHash: previewIpHash(input.ip, now),
      status: "running",
      sourceFormat,
      createdAt: now,
      expiresAt: new Date(now.getTime() + freePreview.retentionDays * 24 * 60 * 60 * 1000),
    })
    .returning({ id: freePreviews.id });
  const id = row.id;

  let run: FreePreviewRun;
  try {
    run = await deps.run({ previewId: id, bytes: ingested.bytes, previewLongSide: freePreview.previewLongSide });
  } catch (err) {
    console.error(`[free-preview] run failed for ${id}`, err);
    await finish(deps.db, id, { status: "failed", blockedReason: "error", costMicros: 0 });
    await recordFunnelEvent(deps.db, { workspaceId: null, name: "preview_made", props: { status: "failed", reason: "error" } });
    return { kind: "unavailable", previewId: id, message: FREE_PREVIEW_COPY.unavailable };
  }
  await bookPreviewSpend(deps.counters, now, run.costMicros);

  let status: FreePreviewStatus = run.status === "done" ? "done" : run.status === "blocked" ? "blocked" : "failed";
  let mainFormat: "jpeg" | "png" | null = null;
  try {
    if (run.status === "done" && run.main && run.cutout && run.preview && run.fidelity) {
      mainFormat = run.main.format === "png" ? "png" : "jpeg";
      // Files are kept only for a preview that was made: a photo moderation
      // stopped, or one with no clean cutout, is never stored.
      await deps.storage.put(previewOriginalKey(id, sourceFormat), ingested.bytes, contentTypeOf(sourceFormat));
      await deps.storage.put(previewCutoutKey(id), run.cutout.bytes, run.cutout.contentType);
      await deps.storage.put(previewMainKey(id, mainFormat), run.main.bytes, contentTypeOf(mainFormat));
    } else if (run.status === "done") {
      status = "failed";
    }
  } catch (err) {
    console.error(`[free-preview] could not store the files of ${id}`, err);
    await finish(deps.db, id, { status: "failed", blockedReason: "storage", costMicros: run.costMicros });
    await recordFunnelEvent(deps.db, { workspaceId: null, name: "preview_made", props: { status: "failed", reason: "storage" } });
    return { kind: "unavailable", previewId: id, message: FREE_PREVIEW_COPY.unavailable };
  }
  const reason = run.status === "blocked" && run.reason === "moderation" ? `moderation: ${run.moderation.join(", ")}` : run.reason;
  await finish(deps.db, id, { status, blockedReason: reason, costMicros: run.costMicros, mainFormat });
  await recordFunnelEvent(deps.db, {
    workspaceId: null,
    name: "preview_made",
    props: { status: run.status, reason: run.reason, checks_pass: run.checksPass },
  });

  if (status === "done" && run.preview && run.fidelity) {
    return {
      kind: "done",
      previewId: id,
      preview: `data:image/jpeg;base64,${run.preview.toString("base64")}`,
      checks: run.checks.map((check) => ({ name: check.name, pass: check.pass })),
      checksPass: run.checksPass,
      fillPct: run.fillPct,
      fidelity: {
        meanDeltaE: run.fidelity.meanDeltaE,
        maxDeltaE: run.fidelity.maxDeltaE,
        exactByteShare: run.fidelity.exactByteShare,
      },
    };
  }
  const kind = run.status === "blocked" ? "blocked" : run.status === "unavailable" ? "unavailable" : "failed";
  return { kind, previewId: id, message: MESSAGES[kind] };
}

/** A preview row that may still be downloaded or claimed: made, and not expired. */
export function previewUsable(row: FreePreview | undefined, now: Date): row is FreePreview {
  return Boolean(row && (row.status === "done" || row.status === "claimed") && row.expiresAt > now && row.mainFormat);
}

/** sha256 of the trimmed, lower cased email: the row keeps no address. */
export function emailKeyOf(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

export type UnlockResult = { kind: "ready"; url: string } | { kind: "not_found" };

/**
 * The full size file for an email (decision 6): the email is stored as a
 * lead with source free-preview (the lead notice applies; Lane 3's consent
 * box decides any marketing email), the row keeps only its sha256, and the
 * answer is a signed link that lasts freePreview.fullSizeLinkSeconds.
 */
export async function unlockFullSize(
  deps: Pick<FreePreviewServiceDeps, "db" | "storage" | "now"> & { leads: LeadStore },
  input: { previewId: string; email: string; marketingConsent?: boolean },
): Promise<UnlockResult> {
  const row = await deps.db.query.freePreviews.findFirst({ where: (t, { eq }) => eq(t.id, input.previewId) });
  if (!previewUsable(row, deps.now())) {
    return { kind: "not_found" };
  }
  await deps.leads.save(input.email, "free-preview", { marketingConsent: input.marketingConsent === true });
  await deps.db.update(freePreviews).set({ emailKey: emailKeyOf(input.email) }).where(eq(freePreviews.id, row.id));
  const format = row.mainFormat === "png" ? "png" : "jpeg";
  const url = await deps.storage.signDownload(
    previewMainKey(row.id, format),
    `curvi-amazon-main.${extensionOf(format)}`,
    freePreview.fullSizeLinkSeconds,
  );
  return { kind: "ready", url };
}
