import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Records the options each pool is created with; postgres-js never connects.
const createDb = vi.hoisted(() => vi.fn((_url: string, _opts: { max?: number; prepare?: boolean }) => ({})));
vi.mock("@curvi/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@curvi/db")>()),
  createDb,
}));

import { getWorkerDb } from "@curvi/trigger/db-runtime";
import { getDb } from "@/lib/services/db";

const DB_URL = "postgres://curvi:curvi@127.0.0.1:1/curvi";
const scope = globalThis as { __curviDb?: unknown; __curviWorkerDb?: unknown };

beforeEach(() => {
  createDb.mockClear();
  delete scope.__curviDb;
  delete scope.__curviWorkerDb;
  vi.stubEnv("DATABASE_URL", DB_URL);
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete scope.__curviDb;
  delete scope.__curviWorkerDb;
});

// Inline packs run in the web process, so one instance holds both pools.
// Two connections each let a busy page or a pack's parallel shots starve
// the health check's select 1 and the runner's settle.
describe("database pools", () => {
  it("gives the app more than 2 connections, safe for the transaction pooler", () => {
    getDb();
    expect(createDb).toHaveBeenCalledTimes(1);
    const [url, opts] = createDb.mock.calls[0];
    expect(url).toBe(DB_URL);
    expect(opts.max).toBeGreaterThan(2);
    expect(opts.prepare).toBe(false);
  });

  it("gives the pack worker more than 2 connections, safe for the transaction pooler", () => {
    getWorkerDb(DB_URL);
    expect(createDb).toHaveBeenCalledTimes(1);
    const [, opts] = createDb.mock.calls[0];
    expect(opts.max).toBeGreaterThan(2);
    expect(opts.prepare).toBe(false);
  });

  it("keeps one instance well inside the pooler's 200 client limit on the smallest computes", () => {
    getDb();
    getWorkerDb(DB_URL);
    const total = createDb.mock.calls.reduce((sum, [, opts]) => sum + (opts.max ?? 0), 0);
    expect(total).toBeLessThanOrEqual(20);
  });
});
