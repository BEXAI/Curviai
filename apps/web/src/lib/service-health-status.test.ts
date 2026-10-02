import { describe, expect, it } from "vitest";
import {
  createHealthCache,
  preflightWarnings,
  runHealthCheck,
  stageBreakerWarnings,
  type HealthCheckDeps,
  type MigrationMark,
} from "./service-health";

// docs/phases/PHASE_20.md P20-15: status ok, degraded or down beside ok,
// with the HTTP status unchanged.

const MIGRATIONS: MigrationMark[] = [{ tag: "0001_init", when: 1000 }];

function deps(overrides: Partial<HealthCheckDeps> = {}): HealthCheckDeps {
  return {
    mode: "db",
    pingDatabase: async () => undefined,
    latestAppliedMigration: async () => 1000,
    runnerStats: () => null,
    migrations: MIGRATIONS,
    timeoutMs: 50,
    uptimeSeconds: () => 1,
    now: () => new Date("2026-10-01T12:00:00Z"),
    logger: { warn: () => undefined },
    ...overrides,
  };
}

/** Every key anywhere in a JSON value, nested ones included. */
function allKeys(value: unknown, path = ""): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => allKeys(item, `${path}[${i}]`));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => [
    `${path}.${key}`,
    ...allKeys(item, `${path}.${key}`),
  ]);
}

describe("runHealthCheck status", () => {
  it("is ok with no warnings, in demo and db mode", async () => {
    const demo = await runHealthCheck(deps({ mode: "demo" }));
    expect(demo.body).toMatchObject({ ok: true, status: "ok", degradedBy: [] });
    const db = await runHealthCheck(deps());
    expect(db).toMatchObject({ status: 200, body: { ok: true, status: "ok", degradedBy: [] } });
  });

  it("stays ok for info warnings", async () => {
    const result = await runHealthCheck(deps({ configWarnings: () => ["recipe_drift", "llm_credits_expiring:openai"] }));
    expect(result).toMatchObject({ status: 200, body: { ok: true, status: "ok", degradedBy: [] } });
  });

  it("is degraded with HTTP 200 and ok true during a quota pause", async () => {
    const result = await runHealthCheck(
      deps({
        configWarnings: () => ["provider_quota:fal-birefnet", "breaker_open:cutout", "packs_paused:quota"],
        classifyContext: () => ({ pausedProviders: ["fal-birefnet"] }),
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      status: "degraded",
      degradedBy: ["provider_quota:fal-birefnet", "breaker_open:cutout", "packs_paused:quota"],
    });
  });

  it("is degraded for a warning code it has never seen", async () => {
    const result = await runHealthCheck(deps({ configWarnings: () => ["brand_new_warning"] }));
    expect(result.body).toMatchObject({ ok: true, status: "degraded", degradedBy: ["brand_new_warning"] });
  });

  it("keeps billing warnings at info until billing is meant to be live or checkout is open", async () => {
    const closed = await runHealthCheck(deps({ configWarnings: () => ["stripe_webhook_secret_missing", "stripe_webhook_quiet"] }));
    expect(closed.body.status).toBe("ok");
    // A readiness problem after launch closes checkout and degrades health.
    const broken = await runHealthCheck(
      deps({
        configWarnings: () => ["stripe_webhook_secret_missing"],
        classifyContext: () => ({ checkoutOpen: false, billingLive: true }),
      }),
    );
    expect(broken.body).toMatchObject({ status: "degraded", degradedBy: ["stripe_webhook_secret_missing"] });
    const open = await runHealthCheck(
      deps({ configWarnings: () => ["stripe_webhook_quiet"], classifyContext: () => ({ checkoutOpen: true, billingLive: true }) }),
    );
    expect(open.body).toMatchObject({ status: "degraded", degradedBy: ["stripe_webhook_quiet"] });
  });

  it("is down for today's ok false cases, with the same HTTP status as before", async () => {
    const dbDown = await runHealthCheck(
      deps({
        pingDatabase: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      }),
    );
    expect(dbDown).toMatchObject({ status: 503, body: { ok: false, status: "down", degradedBy: ["database_failed"] } });

    const behind = await runHealthCheck(deps({ latestAppliedMigration: async () => 1 }));
    expect(behind).toMatchObject({ status: 503, body: { ok: false, status: "down", degradedBy: ["schema_behind"] } });

    const draining = await runHealthCheck(
      deps({ runnerStats: () => ({ concurrency: 1, running: 1, waiting: 0, overdue: 0, draining: true }) }),
    );
    expect(draining).toMatchObject({ status: 503, body: { ok: false, status: "down", degradedBy: ["draining"] } });
  });

  it("is down with HTTP 200 for a database failure after the boot gate opened, listing warnings after it", async () => {
    const cache = createHealthCache();
    expect((await runHealthCheck(deps({ cache }))).status).toBe(200);
    const result = await runHealthCheck(
      deps({
        cache,
        pingDatabase: async () => {
          throw new Error("timeout");
        },
        configWarnings: () => ["memory_high"],
      }),
    );
    expect(result).toMatchObject({ status: 200, body: { ok: false, status: "down", degradedBy: ["database_failed", "memory_high"] } });
  });

  it("puts no other key named status anywhere in the public body", async () => {
    const result = await runHealthCheck(
      deps({
        runnerStats: () => ({ concurrency: 2, running: 1, waiting: 1, overdue: 0, draining: false }),
        configWarnings: () => ["packs_paused:quota"],
      }),
    );
    const statusKeys = allKeys(result.body).filter((path) => path.endsWith(".status"));
    expect(statusKeys).toEqual([".status"]);
    // The keyword the second monitor matches appears exactly as written.
    expect(JSON.stringify({ ...result.body, status: "ok" })).toContain('"status":"ok"');
  });
});

describe("stageBreakerWarnings", () => {
  const providers = [
    { name: "fal-birefnet", stages: ["cutout"], configured: true },
    { name: "fal-birefnet-backup", stages: ["cutout"], configured: true },
    { name: "gemini-image", stages: ["scene_plate", "harmonize"], configured: true },
    { name: "bfl-image", stages: ["scene_plate", "harmonize"], configured: false },
  ];

  function breaker(open: string[]) {
    return { isOpen: async (name: string) => open.includes(name) };
  }

  it("reports a stage only when every configured provider of it is open", async () => {
    expect(await stageBreakerWarnings(providers, breaker(["fal-birefnet"]))).toEqual({ codes: [], pausedProviders: [] });
    expect(await stageBreakerWarnings(providers, breaker(["fal-birefnet", "fal-birefnet-backup"]))).toEqual({
      codes: ["breaker_open:cutout"],
      pausedProviders: ["fal-birefnet", "fal-birefnet-backup"],
    });
    // An unconfigured provider does not keep a stage running.
    expect(await stageBreakerWarnings(providers, breaker(["gemini-image"]))).toEqual({
      codes: ["breaker_open:scene_plate", "breaker_open:harmonize"],
      pausedProviders: ["gemini-image"],
    });
  });

  it("counts a breaker that cannot be read as closed and reports nothing without configured providers", async () => {
    const failing = {
      isOpen: async () => {
        throw new Error("store down");
      },
    };
    expect(await stageBreakerWarnings(providers, failing)).toEqual({ codes: [], pausedProviders: [] });
    expect(await stageBreakerWarnings([], breaker([]))).toEqual({ codes: [], pausedProviders: [] });
  });
});

describe("preflightWarnings", () => {
  it("maps the preflight verdict to health codes", () => {
    expect(preflightWarnings({ verdict: "ok", cause: null })).toEqual([]);
    expect(preflightWarnings({ verdict: "packs_paused", cause: "quota" })).toEqual(["packs_paused:quota"]);
    expect(preflightWarnings({ verdict: "packs_paused", cause: "failures" })).toEqual(["packs_paused:failures"]);
    expect(preflightWarnings({ verdict: "scenes_paused", cause: "failures" })).toEqual(["scenes_paused"]);
  });
});
