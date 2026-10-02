import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The route probes through trigger/src/provider-balance.ts and works out the
// gate through lib/acquisition.ts; the tests swap both for fakes so the
// secret check and the answers can be exercised alone. The balance logic
// runs against PGlite in trigger/src/provider-balance.test.ts.
const fakeDb = vi.hoisted(() => ({ marker: "db" }));
const check = vi.hoisted(() => vi.fn());
const gate = vi.hoisted(() => vi.fn());
const recordRun = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/db", () => ({ getDb: () => fakeDb }));
vi.mock("@curvi/trigger/provider-balance", () => ({
  checkFalBalances: check,
  FounderAlerts: class {},
}));
vi.mock("@curvi/trigger/cap-store", () => ({ PgCapStore: class {} }));
vi.mock("@/lib/acquisition", () => ({ acquisitionStatus: gate }));
vi.mock("@/lib/cron-health", () => ({ recordCronSuccess: recordRun }));

import { POST } from "./route";

const SECRET = "cron-secret-value-for-tests";
const DB_ENV = {
  DATABASE_URL: "postgres://user:pw@db.example.test:6543/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.example.test",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value",
};

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/cron/provider-balance", { method: "POST", headers });
}

beforeEach(() => {
  check.mockReset();
  gate.mockReset();
  recordRun.mockReset();
  for (const name of ["CRON_SECRET", "FAL_ADMIN_KEY", ...Object.keys(DB_ENV)]) {
    vi.stubEnv(name, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/cron/provider-balance", () => {
  it("refuses every call while CRON_SECRET is unset, and a wrong secret", async () => {
    expect((await POST(request({ authorization: "Bearer anything" }))).status).toBe(503);
    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await POST(request())).status).toBe(401);
    expect((await POST(request({ "x-cron-secret": "wrong" }))).status).toBe(401);
    expect(check).not.toHaveBeenCalled();
  });

  it("has nothing to probe in demo mode", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = await POST(request({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: "demo", accounts: [] });
    expect(check).not.toHaveBeenCalled();
  });

  it("probes, works out the gate afresh and records the run, with balances and never keys", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("FAL_ADMIN_KEY", "fal-admin-secret");
    for (const [name, value] of Object.entries(DB_ENV)) vi.stubEnv(name, value);
    check.mockResolvedValueOnce([
      {
        provider: "fal-birefnet",
        adminKeyEnv: "FAL_ADMIN_KEY",
        probed: true,
        keyConfigured: true,
        ok: true,
        status: 200,
        balanceUsd: 2.5,
        currency: "USD",
        band: "pause",
        alert: "pause",
        eventRecorded: true,
      },
    ]);
    gate.mockResolvedValueOnce({ state: "waitlist", reason: "fal_balance" });

    const res = await POST(request({ "x-cron-secret": SECRET }));

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      mode: "db",
      accounts: [{ provider: "fal-birefnet", probed: true, ok: true, status: 200, balanceUsd: 2.5, band: "pause", alert: "pause" }],
      acquisition: "waitlist",
    });
    expect(JSON.stringify(body)).not.toContain("fal-admin-secret");
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ db: fakeDb }));
    expect(gate).toHaveBeenCalledWith({ fresh: true });
    expect(recordRun).toHaveBeenCalledWith(fakeDb, "provider-balance");
  });

  it("answers 500 without recording a run when the check throws", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    for (const [name, value] of Object.entries(DB_ENV)) vi.stubEnv(name, value);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    check.mockRejectedValueOnce(new Error("pool exhausted"));
    const res = await POST(request({ "x-cron-secret": SECRET }));
    expect(res.status).toBe(500);
    expect(recordRun).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
