import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// docs/phases/PHASE_20.md P20-11: pnpm ops:restore-drill reports a passing
// drill here. The write runs on PGlite in lib/ops/restore-drill.test.ts.
const fakeDb = vi.hoisted(() => ({ marker: "db" }));
vi.mock("@/lib/services/db", () => ({ getDb: () => fakeDb }));
const recordRun = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cron-health", () => ({ recordCronSuccess: recordRun, RESTORE_DRILL_RUN: "restore-drill" }));
const recordReport = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ops/backups", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ops/backups")>();
  return { ...actual, recordRestoreDrillReport: recordReport };
});

import { POST } from "./route";

const SECRET = "cron-secret-value-for-tests";
const DB_ENV = {
  DATABASE_URL: "postgres://user:pw@db.example.test:6543/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.example.test",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value",
};

const REPORT = {
  backupKey: "daily/2026/10/01/curvi-20261001T091502Z.tar.age",
  backupCreatedAt: "2026-10-01T09:15:02Z",
  target: "local",
  startedAt: "2026-10-02T15:00:00.000Z",
  finishedAt: "2026-10-02T15:11:40.000Z",
  durationSeconds: 700,
  stepSeconds: { fetch: 20, decrypt: 5, migrate: 95, restore: 540, verify: 40 },
  checksPassed: 9,
  rowsRestored: 12_840,
  latestMigration: "1790000000000",
  rtoTargetMinutes: 120,
  withinRto: true,
};

function request(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/cron/restore-drill-report", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
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

describe("POST /api/cron/restore-drill-report", () => {
  it("refuses without CRON_SECRET configured, and a wrong secret", async () => {
    expect((await POST(request(REPORT, { authorization: "Bearer anything" }))).status).toBe(503);
    dbMode();
    expect((await POST(request(REPORT, { authorization: "Bearer wrong" }))).status).toBe(401);
    expect(recordReport).not.toHaveBeenCalled();
  });

  it("stores the drill as restore_drill:last and records its run for health", async () => {
    dbMode();
    recordReport.mockResolvedValueOnce({ ...REPORT, recordedAt: "2026-10-02T15:11:41.000Z" });
    const res = await POST(request(REPORT, { authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: "db", recorded: true });
    expect(recordReport).toHaveBeenCalledWith(fakeDb, REPORT);
    expect(recordRun).toHaveBeenCalledWith(fakeDb, "restore-drill");
  });

  it("accepts a drill of a local backup file", async () => {
    dbMode();
    const report = { ...REPORT, backupKey: "file:curvi-20261001T091502Z.tar.age", target: "throwaway" };
    recordReport.mockResolvedValueOnce({ ...report, recordedAt: "2026-10-02T15:11:41.000Z" });
    expect((await POST(request(report, { "x-cron-secret": SECRET }))).status).toBe(200);
  });

  it("refuses a malformed report", async () => {
    dbMode();
    const auth = { authorization: `Bearer ${SECRET}` };
    for (const body of [
      { ...REPORT, target: "staging" },
      { ...REPORT, backupKey: "file:../../secrets" },
      { ...REPORT, checksPassed: 0 },
      { ...REPORT, stepSeconds: { ...REPORT.stepSeconds, extra: 1 } },
      { ...REPORT, durationSeconds: -1 },
    ]) {
      expect((await POST(request(body, auth))).status).toBe(400);
    }
    expect(recordReport).not.toHaveBeenCalled();
    expect(recordRun).not.toHaveBeenCalled();
  });

  it("records nothing in demo mode and answers 500 when the write fails", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect(await (await POST(request(REPORT, { authorization: `Bearer ${SECRET}` }))).json()).toEqual({
      ok: true,
      mode: "demo",
      recorded: false,
    });
    dbMode();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    recordReport.mockRejectedValueOnce(new Error("db.example.test refused"));
    const res = await POST(request(REPORT, { authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("db.example.test");
    expect(recordRun).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
