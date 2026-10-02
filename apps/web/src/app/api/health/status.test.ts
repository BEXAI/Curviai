import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker, processBreakerStore } from "@curvi/ai";
import { healthLimits } from "@curvi/pipeline/seed";

// docs/phases/PHASE_20.md P20-15 through the route: status ok, degraded or
// down, with ok and the HTTP status unchanged. The database is a fake that
// tells queries apart by their SQL text.

const fakeDb = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/services/db", () => ({ getDb: () => fakeDb }));

import { CRON_JOBS, RESTORE_DRILL_RUN, cronSettingKey } from "@/lib/cron-health";
import { DEFAULT_PROVIDER_ENTRIES } from "@/lib/health";
import { GET } from "./route";

const DB_ENV = {
  DATABASE_URL: "postgres://user:very-secret-password@db.example.test:6543/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.example.test",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value",
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "access",
  R2_SECRET_ACCESS_KEY: "secret-access",
  OPENAI_API_KEY: "sk-test-openai-value",
  GEMINI_API_KEY: "gemini-test-value",
  FAL_KEY: "fal-test-value",
  // PHASE_18 P18-03: a fal key without its admin key warns fal_admin_key_missing.
  FAL_ADMIN_KEY: "fal-admin-test-value",
};

let databaseBytes = 1024;

type Scope = { __curviHealthCache?: unknown; __curviConfigReportCache?: unknown; __curviPreflight?: unknown; __curviBreakerStore?: unknown };

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-01T12:00:00Z"), toFake: ["Date"] });
  const configNames = [...DEFAULT_PROVIDER_ENTRIES.map((e) => e.envVar), "FAL_KEY_BACKUP", "BFL_API_KEY", "ANTHROPIC_API_KEY"];
  for (const name of [...configNames, "RENDER_GIT_COMMIT", "CRON_SECRET", "CURVI_SHOT_CONCURRENCY", "STRIPE_SECRET_KEY"]) {
    vi.stubEnv(name, "");
  }
  for (const [name, value] of Object.entries(DB_ENV)) {
    vi.stubEnv(name, value);
  }
  const scope = globalThis as Scope;
  scope.__curviHealthCache = undefined;
  scope.__curviConfigReportCache = undefined;
  scope.__curviPreflight = undefined;
  scope.__curviBreakerStore = undefined;
  databaseBytes = 1024;
  fakeDb.execute.mockReset().mockImplementation(async (query: unknown) => {
    const text = JSON.stringify(query);
    if (text.includes("__drizzle_migrations")) return [{ latest: "9999999999999" }];
    if (text.includes("pg_database_size")) return [{ bytes: String(databaseBytes) }];
    if (text.includes("from recipes")) return [];
    if (text.includes("platform_settings")) {
      // Every registered cron and the restore drill ran a minute ago.
      const at = new Date(Date.now() - 60_000).toISOString();
      return [...CRON_JOBS.map((job) => job.name), RESTORE_DRILL_RUN].map((name) => ({
        key: cronSettingKey(name),
        value: { at },
      }));
    }
    return [{ "?column?": 1 }];
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function health(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await GET(new Request("http://localhost/api/health"));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/health status", () => {
  it("is ok in demo mode, as monitors read it", async () => {
    for (const name of Object.keys(DB_ENV)) vi.stubEnv(name, "");
    const res = await GET(new Request("http://localhost/api/health"));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain('"ok":true');
    expect(text).toContain('"status":"ok"');
    expect(JSON.parse(text).degradedBy).toEqual([]);
  });

  it("counts the seeded recipe drift as info, so a healthy db instance stays ok", async () => {
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body.warnings).toEqual(["recipe_drift"]);
    expect(body).toMatchObject({ ok: true, status: "ok", degradedBy: [] });
  });

  it("is degraded with HTTP 200 while the fal account is out of quota", async () => {
    await new CircuitBreaker(processBreakerStore()).tripForQuota("fal-birefnet");

    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("degraded");
    expect(body.degradedBy).toEqual(["provider_quota:fal-birefnet", "breaker_open:cutout", "packs_paused:quota"]);
  });

  it("keeps a quota trip at info while another provider of the stage still serves", async () => {
    vi.stubEnv("FAL_KEY_BACKUP", "fal-backup-test-value");
    await new CircuitBreaker(processBreakerStore()).tripForQuota("fal-birefnet");

    const { body } = await health();
    expect(body.warnings).toContain("provider_quota:fal-birefnet");
    expect(body).toMatchObject({ ok: true, status: "ok", degradedBy: [] });
  });

  it("is degraded past the seeded share of the database size limit", async () => {
    databaseBytes = Math.ceil(healthLimits.dbSizeLimitBytes * healthLimits.dbSizeHighRatio);

    const { body } = await health();
    expect(body).toMatchObject({ ok: true, status: "degraded", degradedBy: ["db_size_high"] });
  });

  it("is down with ok false and the old status codes for today's failures", async () => {
    fakeDb.execute.mockImplementation(async (query: unknown) => {
      if (JSON.stringify(query).includes("__drizzle_migrations")) return [{ latest: "1" }];
      return [{ "?column?": 1 }];
    });
    const behind = await health();
    expect(behind.status).toBe(503);
    expect(behind.body).toMatchObject({ ok: false, status: "down" });
    expect(behind.body.degradedBy).toEqual(expect.arrayContaining(["schema_behind"]));
  });
});
