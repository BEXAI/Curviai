import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// docs/phases/PHASE_20.md P20-10: the backup cron reports here. The route's
// secret check, validation and responses run against fakes; the write
// itself runs on PGlite in lib/ops/backups.test.ts.
const fakeDb = vi.hoisted(() => ({ marker: "db" }));
vi.mock("@/lib/services/db", () => ({ getDb: () => fakeDb }));
const recordRun = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cron-health", () => ({ recordCronSuccess: recordRun }));
const recordReport = vi.hoisted(() => vi.fn());
const readRecorded = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ops/backups", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ops/backups")>();
  return { ...actual, recordBackupReport: recordReport, readRecordedBackup: readRecorded };
});

import { GET, POST } from "./route";

const SECRET = "cron-secret-value-for-tests";
const DB_ENV = {
  DATABASE_URL: "postgres://user:pw@db.example.test:6543/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.example.test",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value",
};

const VALID_REPORT = {
  key: "daily/2026/10/01/curvi-20261001T091502Z.tar.age",
  monthlyKey: "monthly/2026-10/curvi-20261001T091502Z.tar.age",
  bytes: 48_213_117,
  sha256: "a".repeat(64),
  counts: { "public.workspaces": 12, "public.credit_ledger": 340, "auth.users": 12, "drizzle.__drizzle_migrations": 28 },
  ledgerTotalTenths: 4_180,
  latestMigration: "1790000000000",
  serverVersion: "17.6",
  pgDumpVersion: "17.6 (Debian 17.6-1.pgdg120+1)",
  startedAt: "2026-10-01T09:15:02Z",
  finishedAt: "2026-10-01T09:16:40Z",
};

function request(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/cron/backup-report", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function dbMode(): void {
  vi.stubEnv("CRON_SECRET", SECRET);
  for (const [name, value] of Object.entries(DB_ENV)) vi.stubEnv(name, value);
}

beforeEach(() => {
  recordRun.mockReset();
  recordReport.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  for (const name of ["CRON_SECRET", ...Object.keys(DB_ENV)]) {
    vi.stubEnv(name, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/cron/backup-report", () => {
  it("refuses every call while CRON_SECRET is unset", async () => {
    const res = await POST(request(VALID_REPORT, { authorization: "Bearer anything" }));
    expect(res.status).toBe(503);
    expect(recordReport).not.toHaveBeenCalled();
  });

  it("rejects a missing or wrong secret without recording", async () => {
    dbMode();
    expect((await POST(request(VALID_REPORT))).status).toBe(401);
    expect((await POST(request(VALID_REPORT, { "x-cron-secret": "wrong" }))).status).toBe(401);
    expect(recordReport).not.toHaveBeenCalled();
    expect(recordRun).not.toHaveBeenCalled();
  });

  it("stores the report as backup:last and records the cron run", async () => {
    dbMode();
    recordReport.mockResolvedValueOnce({ ...VALID_REPORT, recordedAt: "2026-10-01T09:16:41.000Z" });
    const res = await POST(request(VALID_REPORT, { authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, mode: "db", recorded: true, key: VALID_REPORT.key });
    expect(recordReport).toHaveBeenCalledWith(fakeDb, VALID_REPORT);
    expect(recordRun).toHaveBeenCalledWith(fakeDb, "backup");
  });

  it("accepts a day that is not the 1st, with no monthly copy", async () => {
    dbMode();
    const report = { ...VALID_REPORT, key: "daily/2026/10/02/curvi-20261002T091500Z.tar.age", monthlyKey: null };
    recordReport.mockResolvedValueOnce({ ...report, recordedAt: "2026-10-02T09:16:00.000Z" });
    const res = await POST(request(report, { "x-cron-secret": SECRET }));
    expect(res.status).toBe(200);
    expect(recordReport).toHaveBeenCalledWith(fakeDb, report);
  });

  it("refuses a malformed report and names the fields, not the values", async () => {
    dbMode();
    const auth = { authorization: `Bearer ${SECRET}` };
    const bad = [
      { ...VALID_REPORT, key: "../../etc/passwd" },
      { ...VALID_REPORT, key: "daily/2026/10/01/other.tar" },
      { ...VALID_REPORT, monthlyKey: "monthly/2026-10/curvi-20261002T091502Z.tar.age" },
      { ...VALID_REPORT, sha256: "not-a-hash" },
      { ...VALID_REPORT, bytes: 0 },
      { ...VALID_REPORT, counts: { "public.Workspaces; drop table x": 1 } },
      { ...VALID_REPORT, counts: { "public.workspaces": -1 } },
      { ...VALID_REPORT, startedAt: "yesterday" },
      { ...VALID_REPORT, extra: "field" },
    ];
    for (const body of bad) {
      const res = await POST(request(body, auth));
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).not.toContain("passwd");
      expect(text).not.toContain("drop table");
    }
    expect((await POST(request("{not json", auth))).status).toBe(400);
    expect(recordReport).not.toHaveBeenCalled();
    expect(recordRun).not.toHaveBeenCalled();
  });

  it("refuses a body over the size limit", async () => {
    dbMode();
    const huge = { ...VALID_REPORT, serverVersion: "x".repeat(300 * 1024) };
    const res = await POST(request(huge, { authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(413);
    expect(recordReport).not.toHaveBeenCalled();
  });

  it("records nothing in demo mode", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = await POST(request(VALID_REPORT, { authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: "demo", recorded: false });
    expect(recordReport).not.toHaveBeenCalled();
  });

  it("answers 500 without recording the run when the write fails, so the backup exits non zero", async () => {
    dbMode();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    recordReport.mockRejectedValueOnce(new Error("connection refused to db.example.test"));
    const res = await POST(request(VALID_REPORT, { authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("db.example.test");
    expect(recordRun).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("GET /api/cron/backup-report (the restore drill's check, security review 7)", () => {
  function get(headers: Record<string, string> = {}): NextRequest {
    return new NextRequest("http://localhost/api/cron/backup-report", { headers });
  }

  it("answers the recorded key, size and sha256 to the cron secret only", async () => {
    dbMode();
    readRecorded.mockResolvedValueOnce({ key: VALID_REPORT.key, bytes: 10, sha256: "a".repeat(64), recordedAt: "2026-10-01T09:16:41Z" });
    expect((await GET(get())).status).toBe(401);
    const ok = await GET(get({ authorization: `Bearer ${SECRET}` }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ key: VALID_REPORT.key, bytes: 10, sha256: "a".repeat(64), recordedAt: "2026-10-01T09:16:41Z" });
    readRecorded.mockResolvedValueOnce(null);
    expect((await GET(get({ authorization: `Bearer ${SECRET}` }))).status).toBe(404);
  });
});
