/**
 * The nightly database backup (docs/phases/PHASE_20.md P20-10) and what
 * the restore drill reads back (P20-11). docs/ops/BACKUP_RESTORE.md is the
 * runbook.
 *
 * ops/cron/backup.sh runs as the curvi-backup Render cron. It dumps the
 * public and drizzle schemas and the auth users, identities and factors,
 * writes manifest.json, tars the three files, encrypts the tar with age to
 * the founder's public key, uploads it to the backup bucket under
 * daily/YYYY/MM/DD/ (and monthly/YYYY-MM/ on the 1st), then posts a report
 * to POST /api/cron/backup-report. The route stores that report as
 * platform_settings `backup:last` and records the cron's success, so
 * GET /api/health warns cron_overdue:backup once it goes stale.
 *
 * The report carries no customer data: object keys, sizes, a hash, row
 * counts per table and a ledger total.
 */

import { z } from "zod";
import { platformSettings, sql, type Db } from "@curvi/db";

/** platform_settings key of the newest recorded backup. */
export const BACKUP_LAST_KEY = "backup:last";

/** The file name backup.sh gives each backup: curvi-<UTC stamp>.tar.age. */
const FILE_NAME = String.raw`curvi-\d{8}T\d{6}Z\.tar\.age`;

/** daily/YYYY/MM/DD/curvi-YYYYMMDDTHHMMSSZ.tar.age */
export const DAILY_BACKUP_KEY = new RegExp(String.raw`^daily/\d{4}/\d{2}/\d{2}/${FILE_NAME}$`);

/** monthly/YYYY-MM/curvi-YYYYMMDDTHHMMSSZ.tar.age */
export const MONTHLY_BACKUP_KEY = new RegExp(String.raw`^monthly/\d{4}-\d{2}/${FILE_NAME}$`);

/** schema.table as pg_dump writes it in a COPY line, lower case only. */
export const DUMPED_TABLE_NAME = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

/** The most tables a manifest or report may list; Curvi has about 40. */
const MAX_TABLES = 1_000;

/** A body larger than this is refused before it is parsed. */
export const MAX_REPORT_BYTES = 256 * 1024;

const isoTime = z.iso.datetime();
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
/** A version string from pg_restore --list, such as "17.6 (Debian 17.6-1.pgdg120+1)". */
const versionText = z.string().min(1).max(120);
/** drizzle.__drizzle_migrations.created_at of the newest migration (the
 * journal `when`, milliseconds), as digits; null when the dump had none. */
const migrationMark = z.string().regex(/^\d{1,20}$/).nullable();

/** Row counts per schema.table, taken from the dump itself. */
export const rowCountsSchema = z
  .record(z.string().regex(DUMPED_TABLE_NAME), z.number().int().nonnegative())
  .refine((counts) => Object.keys(counts).length <= MAX_TABLES, { message: `at most ${MAX_TABLES} tables` });

const dumpFileSchema = z.object({ bytes: z.number().int().positive(), sha256: sha256Hex });

/**
 * manifest.json inside every backup (format 1), written by backup.sh from
 * the dump files themselves so the restore drill can compare exactly:
 * - counts: rows per table in the two dumps (public, drizzle and the three
 *   auth tables), counted from the COPY data pg_restore prints;
 * - ledgerTotalTenths: the sum of credit_ledger.delta in tenths of a credit;
 * - latestMigration: the newest drizzle migration in the dump;
 * - files: size and sha256 of public.dump and auth.dump.
 */
export const backupManifestSchema = z.object({
  format: z.literal(1),
  createdAt: isoTime,
  serverVersion: versionText,
  pgDumpVersion: versionText,
  latestMigration: migrationMark,
  ledgerTotalTenths: z.number().int(),
  counts: rowCountsSchema,
  files: z.object({ "public.dump": dumpFileSchema, "auth.dump": dumpFileSchema }),
});

export type BackupManifest = z.infer<typeof backupManifestSchema>;

/** The body backup.sh posts to POST /api/cron/backup-report. */
export const backupReportSchema = z
  .object({
    /** The encrypted file's key under daily/. */
    key: z.string().regex(DAILY_BACKUP_KEY),
    /** The same file's copy under monthly/, on the 1st of a month. */
    monthlyKey: z.string().regex(MONTHLY_BACKUP_KEY).nullable(),
    /** Size and sha256 of the encrypted file as uploaded. */
    bytes: z.number().int().positive(),
    sha256: sha256Hex,
    counts: rowCountsSchema,
    ledgerTotalTenths: z.number().int(),
    latestMigration: migrationMark,
    serverVersion: versionText,
    pgDumpVersion: versionText,
    startedAt: isoTime,
    finishedAt: isoTime,
  })
  .strict()
  .refine((report) => !report.monthlyKey || report.monthlyKey.endsWith(report.key.slice(report.key.lastIndexOf("/"))), {
    message: "monthlyKey must name the same file as key",
    path: ["monthlyKey"],
  });

export type BackupReport = z.infer<typeof backupReportSchema>;

/** What `backup:last` holds: the report and when the server recorded it. */
export interface RecordedBackup extends BackupReport {
  recordedAt: string;
}

export type ReportBodyResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 413; error: string };

/**
 * Reads a JSON body of at most MAX_REPORT_BYTES and validates it. The
 * errors name top level fields only, never the values or keys sent.
 */
export async function readReportBody<T>(request: Request, schema: z.ZodType<T>): Promise<ReportBodyResult<T>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REPORT_BYTES) {
    return { ok: false, status: 413, error: "The report is too large." };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, status: 400, error: "The report could not be read." };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_REPORT_BYTES) {
    return { ok: false, status: 413, error: "The report is too large." };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: "The report is not JSON." };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    // Top level field names only: a record's keys are values the caller sent.
    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "body")))].slice(0, 5);
    return { ok: false, status: 400, error: `The report is not valid: ${fields.join(", ")}.` };
  }
  return { ok: true, value: parsed.data };
}

/** Anything that runs one insert: the owner connection or a transaction. */
type SettingWriter = Pick<Db, "insert">;

/** Upserts one platform_settings row. Throws when the write fails. */
export async function writeSetting(db: SettingWriter, key: string, value: unknown, at: Date): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key, value, updatedAt: at })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
    });
}

/** Stores a backup report as `backup:last`. Throws when the write fails. */
export async function recordBackupReport(db: SettingWriter, report: BackupReport, at: Date = new Date()): Promise<RecordedBackup> {
  const recorded: RecordedBackup = { ...report, recordedAt: at.toISOString() };
  await writeSetting(db, BACKUP_LAST_KEY, recorded, at);
  return recorded;
}

/** What the restore drill checks a downloaded backup against. */
export interface RecordedBackupFacts {
  key: string;
  bytes: number;
  sha256: string;
  recordedAt: string;
}

/** The newest recorded backup's key, size and sha256, or null when none is
 * recorded or the stored value has another shape. */
export async function readRecordedBackup(db: Pick<Db, "select">): Promise<RecordedBackupFacts | null> {
  const [row] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(sql`${platformSettings.key} = ${BACKUP_LAST_KEY}`)
    .limit(1);
  const value = (typeof row?.value === "string" ? safeJson(row.value) : row?.value) as Partial<RecordedBackup> | null | undefined;
  if (
    !value ||
    typeof value.key !== "string" ||
    !DAILY_BACKUP_KEY.test(value.key) ||
    typeof value.bytes !== "number" ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    return null;
  }
  return { key: value.key, bytes: value.bytes, sha256: value.sha256, recordedAt: String(value.recordedAt ?? "") };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The restore drill (P20-11).
// ---------------------------------------------------------------------------

/** platform_settings key of the last passing restore drill. */
export const RESTORE_DRILL_LAST_KEY = "restore_drill:last";

const wholeNumber = z.number().int().nonnegative();

/**
 * The body pnpm ops:restore-drill posts to POST /api/cron/restore-drill-report
 * after every check passed. It names the backup, never its contents.
 */
export const restoreDrillReportSchema = z
  .object({
    /** The daily key the drill restored, or file:<name> for a local file. */
    backupKey: z.union([z.string().regex(DAILY_BACKUP_KEY), z.string().regex(/^file:[A-Za-z0-9._-]{1,200}$/)]),
    /** manifest.json createdAt of that backup. */
    backupCreatedAt: isoTime,
    /** A local Supabase stack, or a throwaway Supabase project. */
    target: z.enum(["local", "throwaway"]),
    startedAt: isoTime,
    finishedAt: isoTime,
    /** From the start of the download to the end of the checks. */
    durationSeconds: wholeNumber,
    stepSeconds: z
      .object({ fetch: wholeNumber, decrypt: wholeNumber, migrate: wholeNumber, restore: wholeNumber, verify: wholeNumber })
      .strict(),
    checksPassed: z.number().int().positive(),
    rowsRestored: wholeNumber,
    latestMigration: migrationMark,
    rtoTargetMinutes: z.number().int().positive(),
    withinRto: z.boolean(),
  })
  .strict();

export type RestoreDrillReport = z.infer<typeof restoreDrillReportSchema>;

/** What `restore_drill:last` holds. */
export interface RecordedRestoreDrill extends RestoreDrillReport {
  recordedAt: string;
}

/** Stores a passing drill as `restore_drill:last`. Throws when the write fails. */
export async function recordRestoreDrillReport(
  db: SettingWriter,
  report: RestoreDrillReport,
  at: Date = new Date(),
): Promise<RecordedRestoreDrill> {
  const recorded: RecordedRestoreDrill = { ...report, recordedAt: at.toISOString() };
  await writeSetting(db, RESTORE_DRILL_LAST_KEY, recorded, at);
  return recorded;
}
