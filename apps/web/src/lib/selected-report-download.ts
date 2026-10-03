/** Selected compliance JSON shared by downloads, PDFs and exported links.
 * Snapshots are immutable derived output artifacts, never replacements for
 * the worker's original report. Read-only callers never create a snapshot. */
import { createHash } from "node:crypto";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { sql, type Db } from "@curvi/db";
import { pickedComplianceReport, StoredComplianceReport } from "./compliance-report";
import { isR2Configured } from "./env";
import { getObjectBytesBounded, isWorkspaceKey, privateBucket, r2Client } from "./r2";
import { isUuid } from "./validation/ids";

const STORAGE_TIMEOUT_MS = 15_000;
/** Reports contain per-file JSON checks, never image bytes. Eight MiB allows
 * thousands of ordinary check records while bounding a locked metadata read. */
export const MAX_SELECTED_REPORT_BYTES = 8 * 1024 * 1024;
export interface ReportStorage {
  read(key: string): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  putIfAbsent(key: string, body: Buffer): Promise<void>;
}

function storageStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}

/** Shared bound for original JSON reads, including file lists and ZIPs. */
export async function readStoredReportBytes(key: string): Promise<Buffer | null> {
  if (!isR2Configured()) return null;
  try {
    return await getObjectBytesBounded(key, MAX_SELECTED_REPORT_BYTES, AbortSignal.timeout(STORAGE_TIMEOUT_MS));
  } catch (error) {
    if (storageStatus(error) === 404) return null;
    throw error;
  }
}

const storage: ReportStorage = {
  read: readStoredReportBytes,
  async exists(key) {
    try {
      await r2Client().send(new HeadObjectCommand({ Bucket: privateBucket(), Key: key }), {
        abortSignal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
      });
      return true;
    } catch (error) {
      if (storageStatus(error) === 404) return false;
      throw error;
    }
  },
  async putIfAbsent(key, body) {
    try {
      await r2Client().send(new PutObjectCommand({
        Bucket: privateBucket(), Key: key, Body: body, ContentType: "application/json; charset=utf-8",
        IfNoneMatch: "*", CacheControl: "private, no-store",
      }), { abortSignal: AbortSignal.timeout(STORAGE_TIMEOUT_MS) });
    } catch (error) {
      if (storageStatus(error) !== 412) throw error;
    }
  },
};

/** Stable semantic comparison allows read-only callers to reuse the original
 * report when its file order alone differs from the current selection. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function comparable(report: StoredComplianceReport): string {
  return canonical({ ...report, files: [...report.files].sort((a, b) => canonical(a).localeCompare(canonical(b))) });
}

export interface SelectedReport {
  report: StoredComplianceReport;
  body: Buffer;
  filename: string;
  originalKey: string | null;
  originalMatches: boolean;
  snapshotKey: string;
}

/** Every row/key is checked against the named workspace and job. No writes. */
export async function readSelectedReport(
  db: Pick<Db, "query">,
  workspaceId: string,
  jobId: string,
  reportId?: string,
  objects: ReportStorage = storage,
): Promise<SelectedReport | null> {
  if (!isUuid(workspaceId) || !isUuid(jobId) || (reportId !== undefined && !isUuid(reportId))) return null;
  const job = await db.query.generationJobs.findFirst({
    where: (t, { and, eq }) => and(eq(t.id, jobId), eq(t.workspaceId, workspaceId)),
  });
  // Exactly the same delivery predicate as DbService.servesFiles.
  if (!job || !(job.status === "done" || Number(job.creditsCharged ?? 0) > 0)) return null;
  const [reports, assets] = await Promise.all([
    db.query.packFiles.findMany({
      where: (t, { and, eq }) => and(eq(t.workspaceId, workspaceId), eq(t.jobId, jobId), eq(t.kind, "report"),
        reportId ? eq(t.id, reportId) : undefined),
    }),
    db.query.assets.findMany({ where: (t, { and, eq }) => and(eq(t.workspaceId, workspaceId), eq(t.jobId, jobId)) }),
  ]);
  const ownReports = reports.filter((row) => isWorkspaceKey(workspaceId, row.r2Key));
  const row = ownReports.find((report) => report.channel === null) ?? ownReports[0];
  if (reportId && !row) return null;
  let raw: unknown = null;
  if (row) {
    const bytes = await objects.read(row.r2Key);
    try { raw = bytes ? JSON.parse(bytes.toString("utf8")) : null; } catch { /* Exact QC may still supply the checks. */ }
  }
  const variants = assets.length ? await db.query.assetVariants.findMany({
    where: (t, { and, eq, inArray }) => and(eq(t.workspaceId, workspaceId), eq(t.picked, true), inArray(t.assetId, assets.map((asset) => asset.id))),
  }) : [];
  const selected = pickedComplianceReport(raw, variants.filter((variant) => isWorkspaceKey(workspaceId, variant.r2Key))
    .sort((a, b) => a.channelSpecId.localeCompare(b.channelSpecId) || a.filename.localeCompare(b.filename) || a.r2Key.localeCompare(b.r2Key))
    .map((variant) => ({ ...variant, workspaceId, jobId })), assets);
  if (!selected) return null;
  const body = Buffer.from(JSON.stringify(selected, null, 2));
  if (body.length > MAX_SELECTED_REPORT_BYTES) throw new Error("Selected report exceeds its byte limit.");
  const original = StoredComplianceReport.safeParse(raw);
  return {
    report: selected, body, filename: row?.filename ?? "compliance-report.json", originalKey: row?.r2Key ?? null,
    originalMatches: original.success && comparable(original.data) === comparable(selected),
    snapshotKey: `ws/${workspaceId}/jobs/${jobId}/reports/selected-${createHash("sha256").update(body).digest("hex")}.json`,
  };
}

/** Return only an existing matching object. This is safe for MCP get_pack. */
export async function existingReportKey(selected: SelectedReport, objects: ReportStorage = storage): Promise<string | null> {
  if (selected.originalMatches && selected.originalKey) return selected.originalKey;
  return await objects.exists(selected.snapshotKey) ? selected.snapshotKey : null;
}

/** Only explicit signed-URL downloads/exports call this. The workspace lock
 * matches account deletion and version picking. Reload after acquiring it.
 * A remote PUT whose response is lost is still an ambiguous storage failure;
 * this lock cannot make R2 and Postgres a distributed transaction. */
export async function prepareReportSnapshot(
  db: Db,
  workspaceId: string,
  jobId: string,
  reportId: string,
  objects: ReportStorage = storage,
): Promise<{ key: string; selected: SelectedReport } | null> {
  if (!isUuid(workspaceId) || !isUuid(jobId) || !isUuid(reportId)) return null;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from workspaces where id = ${workspaceId}::uuid for update`);
    const selected = await readSelectedReport(tx, workspaceId, jobId, reportId, objects);
    if (!selected) return null;
    // Always use selected JSON for explicit links, including its exact size.
    if (!(await objects.exists(selected.snapshotKey))) await objects.putIfAbsent(selected.snapshotKey, selected.body);
    return { key: selected.snapshotKey, selected };
  });
}
