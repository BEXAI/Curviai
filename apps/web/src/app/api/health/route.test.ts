import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route reads the database through getDb; the tests swap in a fake so
// db mode can be exercised without a server.
const fakeDb = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/services/db", () => ({ getDb: () => fakeDb }));

import { DEFAULT_PROVIDER_ENTRIES } from "@/lib/health";
import { GET } from "./route";

const DB_ENV = {
  DATABASE_URL: "postgres://user:very-secret-password@db.example.test:6543/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.example.test",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value",
};

beforeEach(() => {
  fakeDb.execute.mockReset();
  const configNames = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", ...DEFAULT_PROVIDER_ENTRIES.map((e) => e.envVar)];
  for (const name of [...Object.keys(DB_ENV), "RENDER_GIT_COMMIT", ...configNames]) {
    vi.stubEnv(name, "");
  }
  (globalThis as { __curviHealthSchemaCache?: unknown }).__curviHealthSchemaCache = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/health", () => {
  it("returns 200 and ok in demo mode with zero env", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, mode: "demo", checks: { database: "skipped" } });
    expect(fakeDb.execute).not.toHaveBeenCalled();
  });

  it("checks the database in db mode and never echoes env values", async () => {
    for (const [name, value] of Object.entries(DB_ENV)) {
      vi.stubEnv(name, value);
    }
    vi.stubEnv("RENDER_GIT_COMMIT", "0123456789abcdef");
    // select 1, then the newest applied migration far in the future, so the
    // schema reads as current whatever this build ships.
    fakeDb.execute.mockResolvedValueOnce([{ "?column?": 1 }]).mockResolvedValueOnce([{ latest: "9999999999999" }]);

    const res = await GET();
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body).toMatchObject({ ok: true, mode: "db", checks: { database: "ok", schema: "current" }, commit: "0123456" });
    // No storage or provider keys in this env: reported, not failing.
    expect(body.warnings).toEqual(["storage_not_configured", "no_llm_provider", "no_image_provider"]);
    expect(fakeDb.execute).toHaveBeenCalledTimes(2);
    for (const value of Object.values(DB_ENV)) {
      expect(text).not.toContain(value);
    }
    expect(text).not.toContain("very-secret-password");
  });

  it("returns 503 when the database is down", async () => {
    for (const [name, value] of Object.entries(DB_ENV)) {
      vi.stubEnv(name, value);
    }
    fakeDb.execute.mockRejectedValue(new Error("password authentication failed for user"));

    const res = await GET();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ ok: false, checks: { database: "failed" } });
    expect(text).not.toContain("password");
  });

  it("returns 503 when the database is behind this build's migrations", async () => {
    for (const [name, value] of Object.entries(DB_ENV)) {
      vi.stubEnv(name, value);
    }
    fakeDb.execute.mockResolvedValueOnce([{ "?column?": 1 }]).mockResolvedValueOnce([{ latest: "1" }]);

    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, checks: { database: "ok", schema: "behind" } });
  });
});
