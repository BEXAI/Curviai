import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, generationJobs, sql, type Db } from "@curvi/db";
import { InMemoryBreakerStore } from "@curvi/ai";
import { orphan } from "@curvi/pipeline/seed";
import { FounderAlerts } from "@curvi/trigger/provider-balance";
import { notifyStagePaused, resetProviderProbe, storeProviderProbe } from "@curvi/trigger/provider-canary";
import { ProviderQuotaNotifier } from "../../../../../trigger/src/provider-quota";
import { clearProviderPreflightCache, providerPreflightDetail } from "../provider-preflight";
import { recoverOrphanJobs } from "../jobs/recovery";
import { listOperatorJobs, operateJob } from "./jobs";
import { loadOpsOverview } from "./overview";

const state = vi.hoisted(() => ({ db: null as Db | null }));
vi.mock("@/lib/services", () => ({ isDbMode: () => true }));
vi.mock("@/lib/services/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/jobs/settle", () => ({
  settleJob: async (db: Db, _job: unknown, options: { onlyIf: Parameters<Db["execute"]>[0] }) => {
    // Exercise the actual caller's raw guard through the production driver.
    await db.execute(options.onlyIf);
    return { status: "failed" };
  },
}));

const NOW = new Date("2026-10-02T17:20:00.123-05:00");
const JOB = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";
let db: Db;
let seen: Array<{ text: string; params: unknown[] }>;
let replies: (query: string) => unknown[];
let timestampSerialize: (value: unknown) => unknown;

beforeEach(() => {
  // postgres-js connects lazily. Intercept unsafe before any query executes:
  // use real Drizzle compilation and its configured timestamp serializer,
  // but no socket, credentials, PGlite, or database is involved.
  db = createDb("postgres://unused.invalid/offline_date_regression", { prepare: false });
  state.db = db;
  seen = [];
  replies = () => [];
  timestampSerialize = (db.$client as unknown as {
    options: { serializers: Record<number, (value: unknown) => unknown> };
  }).options.serializers[1184];
  vi.spyOn(db.$client, "unsafe").mockImplementation(((text: string, params: unknown[] = []) => {
    seen.push({ text, params: [...params] });
    for (const value of params) {
      if (value instanceof Date || (typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value))) {
        // postgres-js Bind hands the configured serializer's result to its
        // string buffer; a raw Date throws the same ERR_INVALID_ARG_TYPE.
        Buffer.byteLength(timestampSerialize(value) as string);
      }
    }
    return Object.assign(Promise.resolve(replies(text)), { values: async () => [] });
  }) as unknown as typeof db.$client.unsafe);
  vi.spyOn(db, "transaction").mockImplementation(async (run) => run(db as unknown as Parameters<typeof run>[0]));
  vi.spyOn(Date, "now").mockReturnValue(NOW.getTime());
  clearProviderPreflightCache();
});

afterEach(async () => {
  await db.$client.end({ timeout: 0 });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearProviderPreflightCache();
});

function captured(fragment: string) {
  const query = seen.find((entry) => entry.text.includes(fragment));
  expect(query, `missing query: ${fragment}`).toBeDefined();
  return query!;
}

function expectTimestamp(fragment: string, at: Date) {
  const query = captured(fragment);
  expect(query.params).toContain(at.toISOString());
  expect(query.params.some((value) => value instanceof Date)).toBe(false);
  expect(query.text).toContain("::timestamptz");
}

describe("production postgres-js timestamp parameters", () => {
  it("reproduces the raw-Date serializer failure while typed Drizzle timestamps remain valid", async () => {
    expect(timestampSerialize(NOW)).toBe(NOW);
    await expect(db.execute(sql`select ${NOW}::timestamptz`)).rejects.toMatchObject({
      cause: { code: "ERR_INVALID_ARG_TYPE" },
    });
    await db.update(generationJobs).set({ updatedAt: NOW });
    const update = captured('update "generation_jobs"');
    expect(update.params).toContain(NOW.toISOString());
    expect(update.params.some((value) => value instanceof Date)).toBe(false);
  });

  it("binds the provider quota history cutoff as UTC text", async () => {
    vi.stubEnv("FAL_KEY", "synthetic-provider-key-no-network");
    await providerPreflightDetail();
    const query = captured("max(at) as at from events");
    expect(query.params.some((value) => value instanceof Date)).toBe(false);
    expect(query.params.some((value) => typeof value === "string" && /^2026-10-02T/.test(value))).toBe(true);
    expect(query.text).toContain("::timestamptz");
    // The history read must finish rather than being swallowed by preflight.
    captured("provider_quota:last:%");
  });

  it("binds both recovery candidate and settlement fence cutoffs", async () => {
    const stale = new Date(NOW.getTime() - 600_000);
    replies = (query) => query.includes("select id, workspace_id, run_key") ? [{
      id: JOB, workspace_id: WORKSPACE, run_key: "old", status: "generating",
      started_at: stale, created_at: stale, restart_payload: null,
    }] : [];
    expect(await recoverOrphanJobs(db, { now: NOW, owner: "offline-worker" })).toEqual({ claimed: 0, settled: 1, failures: 0 });
    const cutoff = new Date(NOW.getTime() - orphan.staleHeartbeatMinutes * 60_000);
    expectTimestamp("select id, workspace_id, run_key", cutoff);
    expectTimestamp('coalesce("generation_jobs"."heartbeat_at"', cutoff);
  });

  it("binds operator list cutoffs and optional pagination in UTC", async () => {
    await listOperatorJobs(db, { filter: "stuck", before: "2026-10-02T17:00:00.123-05:00" }, NOW);
    const query = captured("from generation_jobs j join products p");
    expect(query.params).toContain("2026-10-02T22:00:00.123Z");
    expectTimestamp("from generation_jobs j join products p", new Date(NOW.getTime() - orphan.staleHeartbeatMinutes * 60_000));
    seen = [];
    await listOperatorJobs(db, { before: "not a timestamp" }, NOW);
    expect(captured("from generation_jobs j join products p").params.filter((value) => value === null)).toHaveLength(4);
  });

  it("decodes real postgres-js timestamp strings before the operator page formats a nonempty list", async () => {
    const parser = (db.$client as unknown as {
      options: { parsers: Record<number, (value: string) => unknown> };
    }).options.parsers[1184];
    const created = parser("2026-10-02 17:20:00.123-05");
    const heartbeat = parser("2026-10-02 22:19:00+00");
    expect(typeof created).toBe("string");
    replies = () => [
      { id: JOB, created_at: created, heartbeat_at: heartbeat },
      { id: "other", created_at: created, heartbeat_at: null },
    ];
    const rows = await listOperatorJobs(db, {});
    expect(rows[0].created_at.toISOString()).toBe(NOW.toISOString());
    expect(rows[0].heartbeat_at?.toISOString()).toBe("2026-10-02T22:19:00.000Z");
    expect(rows[1].heartbeat_at).toBeNull();
  });

  it("binds the operator settlement guard without altering typed job timestamps", async () => {
    vi.stubEnv("OPS_EMAILS", "operator@example.test");
    vi.spyOn(db.query.generationJobs, "findFirst").mockResolvedValue({
      id: JOB, workspaceId: WORKSPACE, status: "generating", runKey: "old", restartCount: 0,
      heartbeatAt: new Date(NOW.getTime() - 600_000),
    } as typeof generationJobs.$inferSelect);
    await operateJob(db, { jobId: JOB, action: "settle", forced: false, operator: "operator@example.test" }, NOW);
    expectTimestamp("heartbeat_at is null or heartbeat_at <=", new Date(NOW.getTime() - orphan.staleHeartbeatMinutes * 60_000));
  });

  it("binds the overview reporting window without passing a Date to postgres-js", async () => {
    await loadOpsOverview(db, NOW);
    expectTimestamp("percentile_cont(0.5)", new Date(NOW.getTime() - 86_400_000));
  });

  it("binds durable provider pass, reset, pause and quota timestamps", async () => {
    await storeProviderProbe(db, "fal-birefnet", { ok: true, status: 200, latencyMs: 1 }, NOW);
    expectTimestamp("insert into platform_settings", NOW);
    seen = [];
    await resetProviderProbe(db, "fal-birefnet", NOW, new InMemoryBreakerStore());
    expectTimestamp("insert into platform_settings", NOW);
    seen = [];
    const alerts = new FounderAlerts({ readEnv: () => undefined });
    const send = vi.spyOn(alerts, "send").mockResolvedValue("log");
    await notifyStagePaused(db, "packs_paused", alerts, NOW);
    expectTimestamp("insert into platform_settings", NOW);
    expect(send).not.toHaveBeenCalled();
    seen = [];
    const notifier = new ProviderQuotaNotifier({ db, now: () => NOW.getTime(), alerts });
    await notifier.notify({ provider: "fal-birefnet", task: "cutout", message: "Synthetic quota fixture" });
    expectTimestamp("insert into platform_settings", NOW);
  });
});
