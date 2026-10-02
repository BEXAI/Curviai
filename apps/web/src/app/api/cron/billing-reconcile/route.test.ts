import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/cron/billing-reconcile (docs/phases/PHASE_20.md P20-02).

const state = vi.hoisted(() => ({
  dbMode: true,
  runs: [] as Array<Record<string, unknown>>,
  cronRecorded: [] as string[],
}));

vi.mock("@/lib/services", () => ({ isDbMode: () => state.dbMode }));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({ fake: "db" }) }));
vi.mock("@/lib/cron-health", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cron-health")>()),
  recordCronSuccess: async (_db: unknown, name: string) => {
    state.cronRecorded.push(name);
  },
}));
vi.mock("@/lib/billing/reconcile-run", () => ({
  runBillingReconcile: async (deps: Record<string, unknown>) => {
    state.runs.push(deps);
    return {
      dryRun: deps.dryRun,
      since: "2026-10-02T12:00:00.000Z",
      emailed: false,
      endpoint: { ok: true, problems: [] },
      result: {
        scanned: 1,
        applied: 1,
        alreadyApplied: 0,
        ignored: 0,
        appliedEvents: [],
        acknowledged: [],
        failed: [],
        truncated: false,
        resumeFrom: null,
        newestEventAt: null,
      },
    };
  },
}));

const { POST } = await import("./route");

const SECRET = "reconcile-secret";

function request(query = "", headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }): Request {
  return new Request(`https://curvi.ai/api/cron/billing-reconcile${query}`, { method: "POST", headers });
}

beforeEach(() => {
  state.dbMode = true;
  state.runs = [];
  state.cronRecorded = [];
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_reconcile");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/cron/billing-reconcile", () => {
  it("answers 503 without CRON_SECRET and 401 with a wrong one, running nothing", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST(request())).status).toBe(503);
    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await POST(request("", { authorization: "Bearer nope" }))).status).toBe(401);
    expect(state.runs).toEqual([]);
  });

  it("skips in demo mode", async () => {
    state.dbMode = false;
    expect(await (await POST(request())).json()).toMatchObject({ ok: true, mode: "demo" });
    expect(state.runs).toEqual([]);
  });

  it("counts a run without a Stripe key as done, so the cron stays fresh while billing is off", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const body = await (await POST(request())).json();
    expect(body).toMatchObject({ ok: true });
    expect(body.skipped).toContain("Stripe has no key");
    expect(state.cronRecorded).toEqual(["billing-reconcile"]);
    expect(state.runs).toEqual([]);
  });

  it("runs the reconcile with a read only lookup and no Stripe write actions", async () => {
    const body = await (await POST(request())).json();
    expect(body).toMatchObject({ ok: true, dryRun: false, applied: 1, scanned: 1 });
    expect(state.runs).toHaveLength(1);
    const deps = state.runs[0];
    expect(deps.dryRun).toBe(false);
    expect(typeof (deps.lookup as { retrieveSubscription?: unknown }).retrieveSubscription).toBe("function");
    expect(deps).not.toHaveProperty("actions");
  });

  it("passes ?dryRun=1 through", async () => {
    const body = await (await POST(request("?dryRun=1"))).json();
    expect(body.dryRun).toBe(true);
    expect(state.runs[0]?.dryRun).toBe(true);
  });
});
