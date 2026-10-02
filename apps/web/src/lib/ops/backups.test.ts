import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@curvi/db";
import { createTestDb } from "@curvi/db/testing";
import {
  BACKUP_LAST_KEY,
  DAILY_BACKUP_KEY,
  MONTHLY_BACKUP_KEY,
  backupManifestSchema,
  backupReportSchema,
  readReportBody,
  readRecordedBackup,
  recordBackupReport,
  type BackupReport,
} from "./backups";

// docs/phases/PHASE_20.md P20-10.

const REPORT: BackupReport = {
  key: "daily/2026/10/01/curvi-20261001T091502Z.tar.age",
  monthlyKey: "monthly/2026-10/curvi-20261001T091502Z.tar.age",
  bytes: 1_024,
  sha256: "b".repeat(64),
  counts: { "public.workspaces": 2, "auth.users": 2 },
  ledgerTotalTenths: 300,
  latestMigration: "1790000000000",
  serverVersion: "17.6",
  pgDumpVersion: "17.6",
  startedAt: "2026-10-01T09:15:02Z",
  finishedAt: "2026-10-01T09:16:40Z",
};

describe("backup keys", () => {
  it("match only the names backup.sh writes", () => {
    expect(DAILY_BACKUP_KEY.test("daily/2026/10/01/curvi-20261001T091502Z.tar.age")).toBe(true);
    expect(MONTHLY_BACKUP_KEY.test("monthly/2026-10/curvi-20261001T091502Z.tar.age")).toBe(true);
    expect(DAILY_BACKUP_KEY.test("daily/2026/10/01/curvi-20261001T091502Z.tar")).toBe(false);
    expect(DAILY_BACKUP_KEY.test("monthly/2026-10/curvi-20261001T091502Z.tar.age")).toBe(false);
    expect(DAILY_BACKUP_KEY.test("daily/2026/10/01/../curvi-20261001T091502Z.tar.age")).toBe(false);
  });
});

describe("backupManifestSchema", () => {
  const manifest = {
    format: 1,
    createdAt: "2026-10-01T09:15:02Z",
    serverVersion: "17.6",
    pgDumpVersion: "17.6 (Debian 17.6-1.pgdg120+1)",
    latestMigration: null,
    ledgerTotalTenths: -5,
    counts: { "public.workspaces": 0 },
    files: { "public.dump": { bytes: 10, sha256: "c".repeat(64) }, "auth.dump": { bytes: 5, sha256: "d".repeat(64) } },
  };

  it("accepts a manifest and refuses a different format or a missing file", () => {
    expect(backupManifestSchema.safeParse(manifest).success).toBe(true);
    expect(backupManifestSchema.safeParse({ ...manifest, format: 2 }).success).toBe(false);
    expect(backupManifestSchema.safeParse({ ...manifest, files: { "public.dump": manifest.files["public.dump"] } }).success).toBe(false);
  });
});

describe("readReportBody", () => {
  it("validates JSON against the schema and names the bad fields", async () => {
    const ok = await readReportBody(new Request("http://x", { method: "POST", body: JSON.stringify(REPORT) }), backupReportSchema);
    expect(ok).toEqual({ ok: true, value: REPORT });
    const bad = await readReportBody(
      new Request("http://x", { method: "POST", body: JSON.stringify({ ...REPORT, bytes: "many" }) }),
      backupReportSchema,
    );
    expect(bad).toEqual({ ok: false, status: 400, error: "The report is not valid: bytes." });
  });

  it("refuses a declared length over the limit without reading the body", async () => {
    const res = await readReportBody(
      new Request("http://x", { method: "POST", body: "{}", headers: { "content-length": String(10 * 1024 * 1024) } }),
      backupReportSchema,
    );
    expect(res).toEqual({ ok: false, status: 413, error: "The report is too large." });
  });
});

describe("recordBackupReport", () => {
  let client: Awaited<ReturnType<typeof createTestDb>>["client"];
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];

  beforeAll(async () => {
    const created = await createTestDb();
    client = created.client;
    db = created.db;
  });

  afterAll(async () => {
    await client.close();
  });

  it("keeps one backup:last row holding the newest report", async () => {
    await recordBackupReport(db as unknown as Db, REPORT, new Date("2026-10-01T09:16:41Z"));
    const next = { ...REPORT, key: "daily/2026/10/02/curvi-20261002T091500Z.tar.age", monthlyKey: null };
    await recordBackupReport(db as unknown as Db, next, new Date("2026-10-02T09:16:00Z"));

    const rows = await client.query<{ value: Record<string, unknown>; updated_at: Date }>(
      "select value, updated_at from platform_settings where key = $1",
      [BACKUP_LAST_KEY],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].value).toEqual({ ...next, recordedAt: "2026-10-02T09:16:00.000Z" });
    expect(new Date(rows.rows[0].updated_at).toISOString()).toBe("2026-10-02T09:16:00.000Z");
  });

  it("reads back the recorded key, size and sha256 for the restore drill", async () => {
    expect(await readRecordedBackup(db as unknown as Db)).toEqual({
      key: "daily/2026/10/02/curvi-20261002T091500Z.tar.age",
      bytes: REPORT.bytes,
      sha256: REPORT.sha256,
      recordedAt: "2026-10-02T09:16:00.000Z",
    });
    await client.query("update platform_settings set value = '{\"key\":\"elsewhere\"}'::jsonb where key = $1", [BACKUP_LAST_KEY]);
    expect(await readRecordedBackup(db as unknown as Db)).toBeNull();
  });
});
