import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The purge itself runs against PGlite in lib/trust; here only the route's
// secret check and its run record for the health endpoint are exercised.
const fakeDb = vi.hoisted(() => ({ marker: "db" }));
const purge = vi.hoisted(() => vi.fn());
const recordRun = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/db", () => ({ getDb: () => fakeDb }));
vi.mock("@/lib/trust/purge", () => ({ purgeStaleSourceMedia: purge }));
vi.mock("@/lib/trust/storage", () => ({ r2TrustStorage: () => ({}) }));
vi.mock("@/lib/cron-health", () => ({ recordCronSuccess: recordRun }));

import { POST } from "./route";

const SECRET = "purge-secret-value-for-tests";
const ENV = {
  DATABASE_URL: "postgres://user:pw@db.example.test:6543/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.example.test",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value",
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "key-id",
  R2_SECRET_ACCESS_KEY: "key-secret",
};

function request(query = ""): Request {
  return new Request(`http://localhost/api/cron/purge-source-media${query}`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

beforeEach(() => {
  purge.mockReset();
  recordRun.mockReset();
  vi.stubEnv("CRON_SECRET", SECRET);
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/cron/purge-source-media run record", () => {
  it("does not advance freshness when object deletion partially fails", async () => {
    purge.mockResolvedValueOnce({ rowsMatched: 2, objectsFailed: 1 });
    expect((await POST(request())).status).toBe(503);
    expect(recordRun).not.toHaveBeenCalled();
  });
  it("records a successful real run for the health endpoint", async () => {
    purge.mockResolvedValueOnce({ rowsMatched: 0 });
    expect((await POST(request())).status).toBe(200);
    expect(recordRun).toHaveBeenCalledWith(fakeDb, "purge-source-media");
  });

  it("records nothing for a dry run or a failed run", async () => {
    purge.mockResolvedValueOnce({ rowsMatched: 3 });
    expect((await POST(request("?dryRun=1"))).status).toBe(200);
    purge.mockRejectedValueOnce(new Error("r2 down"));
    expect((await POST(request())).status).toBe(500);
    expect(recordRun).not.toHaveBeenCalled();
  });
});
