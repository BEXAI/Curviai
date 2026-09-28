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

/** A plain poll, as Render sends it: no secret. */
function healthGet(): Request {
  return new Request("http://localhost/api/health");
}

beforeEach(() => {
  fakeDb.execute.mockReset();
  const configNames = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", ...DEFAULT_PROVIDER_ENTRIES.map((e) => e.envVar)];
  for (const name of [...Object.keys(DB_ENV), "RENDER_GIT_COMMIT", "CRON_SECRET", "CURVI_SHOT_CONCURRENCY", ...configNames]) {
    vi.stubEnv(name, "");
  }
  const scope = globalThis as { __curviHealthCache?: unknown; __curviConfigReportCache?: unknown };
  scope.__curviHealthCache = undefined;
  scope.__curviConfigReportCache = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/health", () => {
  it("returns 200 and ok in demo mode with zero env", async () => {
    const res = await GET(healthGet());
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

    const res = await GET(healthGet());
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body).toMatchObject({ ok: true, mode: "db", checks: { database: "ok", schema: "current" }, commit: "0123456" });
    // No storage or provider keys in this env, an empty recipes table and
    // no cron runs: reported as codes, not failing.
    expect(body.warnings).toEqual([
      "storage_not_configured",
      "no_llm_provider",
      "no_image_provider",
      "no_cutout_provider",
      "recipe_drift",
      "cron_never_ran:stale-jobs",
      "cron_never_ran:purge-source-media",
    ]);
    expect(body.details).toBeUndefined();
    // select 1, the migration read, then the recipes and cron reads.
    expect(fakeDb.execute).toHaveBeenCalledTimes(4);
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

    const res = await GET(healthGet());
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ ok: false, checks: { database: "failed" } });
    expect(text).not.toContain("password");
  });

  it("after a whole check passed, reports a database failure in the body but answers 200", async () => {
    for (const [name, value] of Object.entries(DB_ENV)) {
      vi.stubEnv(name, value);
    }
    fakeDb.execute.mockResolvedValueOnce([{ "?column?": 1 }]).mockResolvedValueOnce([{ latest: "9999999999999" }]);
    expect((await GET(healthGet())).status).toBe(200);

    // A later outage: Render must not restart the instance over it (that
    // would fail running packs), but monitors still see ok false.
    fakeDb.execute.mockRejectedValue(new Error("connect ETIMEDOUT"));
    const res = await GET(healthGet());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, checks: { database: "failed", schema: "unknown" } });
  });

  it("returns 503 when the database is behind this build's migrations", async () => {
    for (const [name, value] of Object.entries(DB_ENV)) {
      vi.stubEnv(name, value);
    }
    fakeDb.execute.mockResolvedValueOnce([{ "?column?": 1 }]).mockResolvedValueOnce([{ latest: "1" }]);

    const res = await GET(healthGet());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, checks: { database: "ok", schema: "behind" } });
  });
});

describe("GET /api/health detailed report", () => {
  const SECRET = "health-secret-value-for-tests";

  function healthRequest(headers: Record<string, string> = {}): Request {
    return new Request("http://localhost/api/health", { headers });
  }

  /** db mode with a current schema, an empty recipes table and one recent
   * stale-jobs run. Queries are told apart by their SQL text. */
  function dbMode(): void {
    for (const [name, value] of Object.entries(DB_ENV)) {
      vi.stubEnv(name, value);
    }
    fakeDb.execute.mockImplementation(async (query: unknown) => {
      const text = JSON.stringify(query);
      if (text.includes("__drizzle_migrations")) return [{ latest: "9999999999999" }];
      if (text.includes("from recipes")) return [];
      if (text.includes("platform_settings")) {
        return [{ key: "cron:stale-jobs:last_success", value: { at: new Date(Date.now() - 60_000).toISOString() } }];
      }
      return [{ "?column?": 1 }];
    });
  }

  it("adds details with the right bearer secret and keeps env values out", async () => {
    dbMode();
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-live-anthropic-value");
    vi.stubEnv("CURVI_SHOT_CONCURRENCY", "3");

    const res = await GET(healthRequest({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.warnings).toContain("recipe_drift");
    expect(body.warnings).not.toContain("no_llm_provider");
    expect(body.details.warnings).toContainEqual({
      code: "cron_never_ran:purge-source-media",
      message: "The purge-source-media cron has never recorded a successful run.",
    });
    expect(body.details.crons.map((c: { name: string; state: string }) => [c.name, c.state])).toEqual([
      ["stale-jobs", "fresh"],
      ["purge-source-media", "never"],
    ]);
    expect(body.details.recipes.drift.length).toBeGreaterThan(0);
    expect(body.details.providerKeys.find((s: { stage: string }) => s.stage === "analyze")).toMatchObject({
      ready: true,
      keys: [{ envVar: "ANTHROPIC_API_KEY", present: true }],
    });
    expect(body.details.runtime.shotConcurrency).toEqual({ configured: "3", effective: 3 });
    expect(typeof body.details.runtime.memory.rssBytes).toBe("number");
    expect(text).not.toContain("sk-live-anthropic-value");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("very-secret-password");
  });

  it("gives the public response to a wrong, missing or unconfigured secret", async () => {
    dbMode();
    vi.stubEnv("CRON_SECRET", SECRET);
    const attempts: Record<string, string>[] = [{}, { authorization: "Bearer wrong" }, { authorization: SECRET }];
    for (const headers of attempts) {
      const res = await GET(healthRequest(headers));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.details).toBeUndefined();
      expect(body.warnings).toContain("cron_never_ran:purge-source-media");
    }

    vi.stubEnv("CRON_SECRET", "");
    const res = await GET(healthRequest({ authorization: "Bearer " }));
    expect((await res.json()).details).toBeUndefined();
  });

  it("reports details in demo mode too, without database reads", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = await GET(healthRequest({ authorization: `Bearer ${SECRET}` }));
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, mode: "demo", warnings: [] });
    expect(body.details).toMatchObject({ recipes: null, crons: null });
    expect(fakeDb.execute).not.toHaveBeenCalled();
  });
});
