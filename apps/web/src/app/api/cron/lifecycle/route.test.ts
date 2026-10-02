import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CREDIT_TERMS_SENTENCE } from "@/lib/marketing-facts";
import { verifyFeedbackToken } from "@/lib/feedback/link";

// POST /api/cron/lifecycle (P18-07): the cron secret, demo mode, the dry
// run, the acquisition gate and the run record for /api/health. The run
// itself is tested against PGlite in packages/email/src/run.test.ts.

const state = vi.hoisted(() => ({ dbMode: true, gate: "open" as "open" | "waitlist" }));
const fakeDb = vi.hoisted(() => ({ marker: "db" }));
const run = vi.hoisted(() => vi.fn());
const recordRun = vi.hoisted(() => vi.fn());
const summary = vi.hoisted(() => vi.fn());

vi.mock("@/lib/services", () => ({ isDbMode: () => state.dbMode }));
vi.mock("@/lib/services/db", () => ({ getDb: () => fakeDb }));
vi.mock("@/lib/cron-health", () => ({ recordCronSuccess: recordRun }));
vi.mock("@/lib/acquisition", () => ({ acquisitionStatus: async () => ({ state: state.gate, reason: null }) }));
vi.mock("@curvi/email", async (importOriginal) => ({ ...(await importOriginal<object>()), runLifecycle: run }));
vi.mock("@curvi/db", async (importOriginal) => ({ ...(await importOriginal<object>()), packFidelitySummary: summary }));

const { POST } = await import("./route");

const SECRET = "lifecycle-cron-secret-for-tests";

function request(query = "", secret: string | null = SECRET): Request {
  return new Request(`http://localhost/api/cron/lifecycle${query}`, {
    method: "POST",
    headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
  });
}

beforeEach(() => {
  run.mockReset();
  recordRun.mockReset();
  summary.mockReset();
  state.dbMode = true;
  state.gate = "open";
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("LIFECYCLE_EMAIL_FROM", "Curvi <hello@updates.curvi.ai>");
  vi.stubEnv("OPS_EMAILS", "Founder@Curvi.ai");
  run.mockResolvedValue({ status: "ran", due: 2, attempted: 2, sent: 2, byTemplate: { welcome: { due: 1, sent: 1 } } });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/cron/lifecycle", () => {
  it("signs feedback for the actual pack owner, with the normal expiry and no login redirect", async () => {
    const secret = "test-feedback-signing-secret-long-enough";
    vi.stubEnv("CURVI_LINK_SECRET", secret);
    await POST(request());
    const { feedbackLink } = run.mock.calls[0][0];
    const now = new Date("2026-10-02T12:00:00Z");
    const input = { jobId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002", now };
    const path = feedbackLink(input);
    expect(path).toMatch(/^\/feedback\//);
    expect(verifyFeedbackToken(path.slice("/feedback/".length), { now, secret })).toEqual({ jobId: input.jobId, userId: input.userId });
    vi.stubEnv("CURVI_LINK_SECRET", "short");
    expect(feedbackLink(input)).toBeNull();
  });
  it("answers 503 without a secret and 401 with a wrong one, running nothing", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST(request())).status).toBe(503);
    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await POST(request("", "wrong"))).status).toBe(401);
    expect((await POST(request("", null))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("skips demo mode", async () => {
    state.dbMode = false;
    const response = await POST(request());
    expect(await response.json()).toMatchObject({ ok: true, skipped: "The database is not configured." });
    expect(run).not.toHaveBeenCalled();
  });

  it("runs with the gate, the config and the pack estimate, then records the run", async () => {
    state.gate = "waitlist";
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: "ran", sent: 2 });
    const deps = run.mock.calls[0][0];
    expect(deps).toMatchObject({ db: fakeDb, acquisitionOpen: false, dryRun: false });
    expect(deps.typicalPackCredits).toBeGreaterThan(0);
    expect(deps.creditTerms).toBe(CREDIT_TERMS_SENTENCE);
    expect(deps.config).toMatchObject({ apiKey: "re_test_key", from: "Curvi <hello@updates.curvi.ai>" });
    expect(deps.excludeOwnerEmails).toEqual(["founder@curvi.ai"]);
    expect(recordRun).toHaveBeenCalledWith(fakeDb, "lifecycle");
  });

  it("reads the pack's measured check for the pack ready email", async () => {
    await POST(request());
    const { fidelity } = run.mock.calls[0][0];
    summary.mockResolvedValueOnce({ deliveredFiles: 6, measuredFiles: 5, highestMeanDeltaE: 0.84, highestMaxDeltaE: 3, allWithinLimits: true });
    expect(await fidelity({ jobId: "j", workspaceId: "w" })).toEqual({ highestMean: 0.84, allWithinLimits: true });
    summary.mockResolvedValueOnce({ deliveredFiles: 6, measuredFiles: 0, highestMeanDeltaE: null, highestMaxDeltaE: null, allWithinLimits: true });
    expect(await fidelity({ jobId: "j", workspaceId: "w" })).toBeNull();
  });

  it("dry runs without recording a run", async () => {
    run.mockResolvedValueOnce({ status: "dry_run", due: 3, attempted: 0, sent: 0, byTemplate: {} });
    const response = await POST(request("?dryRun=1"));
    expect(await response.json()).toMatchObject({ ok: true, status: "dry_run", due: 3 });
    expect(run.mock.calls[0][0].dryRun).toBe(true);
    expect(recordRun).not.toHaveBeenCalled();
  });

  it("keeps a partially failed send run due, then records only a completed retry", async () => {
    run.mockResolvedValueOnce({ status: "ran", due: 2, attempted: 2, sent: 1,
      byTemplate: { welcome: { due: 2, sent: 1, failed: 1 } } });
    const partial = await POST(request());
    expect(partial.status).toBe(503);
    expect(await partial.json()).toMatchObject({ ok: false, failed: 1, sent: 1 });
    expect(recordRun).not.toHaveBeenCalled();
    const retry = await POST(request());
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ ok: true, failed: 0 });
    expect(recordRun).toHaveBeenCalledExactlyOnceWith(fakeDb, "lifecycle");
  });

  it.each([
    { status: "switched_off", byTemplate: {} },
    { status: "not_configured", byTemplate: {}, missing: ["RESEND_API_KEY"] },
    { status: "ran", byTemplate: { welcome: { disabled: 1 } } },
    { status: "ran", byTemplate: { lead_results: { waiting: 1 } } },
    { status: "ran", byTemplate: {}, stoppedBy: "run_cap" },
    { status: "ran", byTemplate: {}, stoppedBy: "day_cap" },
  ])("does not advance success for skipped or incomplete work: %j", async (report) => {
    run.mockResolvedValueOnce({ due: 1, attempted: 0, sent: 0, ...report });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, failed: 0, skipped: expect.any(String) });
    expect(recordRun).not.toHaveBeenCalled();
  });

  it("records a completed run whose due emails were already sent or suppressed", async () => {
    run.mockResolvedValueOnce({ status: "ran", due: 2, attempted: 0, sent: 0,
      byTemplate: { welcome: { due: 2, duplicate: 1, suppressed: 1 } } });
    expect((await POST(request())).status).toBe(200);
    expect(recordRun).toHaveBeenCalledExactlyOnceWith(fakeDb, "lifecycle");
  });

  it("answers 500 when the run throws", async () => {
    run.mockRejectedValueOnce(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(recordRun).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
