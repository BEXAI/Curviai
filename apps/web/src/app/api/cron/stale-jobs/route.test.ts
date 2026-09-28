import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The route sweeps through getDb and sweepStaleJobs; the tests swap both for
// fakes so the secret check and the responses can be exercised alone. The
// sweep itself runs against PGlite in lib/services/stale-sweep.test.ts.
const fakeDb = vi.hoisted(() => ({ marker: "db" }));
const sweep = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/db", () => ({ getDb: () => fakeDb }));
vi.mock("@/lib/services/reconcile", () => ({ sweepStaleJobs: sweep }));
const recordRun = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cron-health", () => ({ recordCronSuccess: recordRun }));

import { checkCronAuth } from "@/lib/cron-auth";
import { POST } from "./route";

const SECRET = "cron-secret-value-for-tests";
const DB_ENV = {
  DATABASE_URL: "postgres://user:pw@db.example.test:6543/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.example.test",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value",
};

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/cron/stale-jobs", { method: "POST", headers });
}

beforeEach(() => {
  sweep.mockReset();
  recordRun.mockReset();
  for (const name of ["CRON_SECRET", ...Object.keys(DB_ENV)]) {
    vi.stubEnv(name, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("checkCronAuth", () => {
  it("accepts the secret as a bearer token or the x-cron-secret header", () => {
    expect(checkCronAuth(new Headers({ authorization: `Bearer ${SECRET}` }), SECRET)).toBe("ok");
    expect(checkCronAuth(new Headers({ "x-cron-secret": SECRET }), SECRET)).toBe("ok");
  });

  it("denies a wrong, empty or differently sized secret and fails closed without one", () => {
    expect(checkCronAuth(new Headers({ authorization: "Bearer nope" }), SECRET)).toBe("denied");
    expect(checkCronAuth(new Headers({ authorization: `Bearer ${SECRET}x` }), SECRET)).toBe("denied");
    expect(checkCronAuth(new Headers({ authorization: SECRET }), SECRET)).toBe("denied");
    expect(checkCronAuth(new Headers(), SECRET)).toBe("denied");
    expect(checkCronAuth(new Headers({ authorization: `Bearer ${SECRET}` }), undefined)).toBe("unconfigured");
  });
});

describe("POST /api/cron/stale-jobs", () => {
  it("refuses every call while CRON_SECRET is unset", async () => {
    const res = await POST(request({ authorization: "Bearer anything" }));
    expect(res.status).toBe(503);
    expect(sweep).not.toHaveBeenCalled();
  });

  it("rejects a missing or wrong secret without sweeping", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await POST(request())).status).toBe(401);
    expect((await POST(request({ "x-cron-secret": "wrong" }))).status).toBe(401);
    expect(sweep).not.toHaveBeenCalled();
  });

  it("has nothing to sweep in demo mode", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = await POST(request({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: "demo", reconciled: 0 });
    expect(sweep).not.toHaveBeenCalled();
  });

  it("sweeps in db mode and reports what it settled", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    for (const [name, value] of Object.entries(DB_ENV)) vi.stubEnv(name, value);
    sweep.mockResolvedValueOnce({ reconciled: [{ id: "job-1", workspaceId: "ws-1" }], releaseFailures: [] });

    const res = await POST(request({ "x-cron-secret": SECRET }));

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, mode: "db", reconciled: 1, jobIds: ["job-1"], releaseFailures: [] });
    expect(sweep).toHaveBeenCalledWith(fakeDb);
    // The health endpoint reads this to warn when the sweep stops running.
    expect(recordRun).toHaveBeenCalledWith(fakeDb, "stale-jobs");
  });

  it("answers 500 when a release failed or the database is down, so the scheduler flags the run", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    for (const [name, value] of Object.entries(DB_ENV)) vi.stubEnv(name, value);
    sweep.mockResolvedValueOnce({ reconciled: [{ id: "job-1", workspaceId: "ws-1" }], releaseFailures: ["job-1"] });
    expect((await POST(request({ "x-cron-secret": SECRET }))).status).toBe(500);
    expect(recordRun).not.toHaveBeenCalled();

    sweep.mockRejectedValueOnce(new Error("connection refused"));
    const res = await POST(request({ "x-cron-secret": SECRET }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("connection refused");
  });
});
