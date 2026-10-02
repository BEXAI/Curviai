import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/cron/funnel-digest (P18-02): the cron secret, the database and
// email settings, the dry run, and the run record for /api/health. The
// digest itself runs against PGlite in lib/funnel-digest.test.ts.

const state = vi.hoisted(() => ({ dbMode: true }));
const fakeDb = vi.hoisted(() => ({ marker: "db" }));
const run = vi.hoisted(() => vi.fn());
const recordRun = vi.hoisted(() => vi.fn());
const sendFounderEmail = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("@/lib/services", () => ({ isDbMode: () => state.dbMode }));
vi.mock("@/lib/services/db", () => ({ getDb: () => fakeDb }));
vi.mock("@/lib/funnel-digest", () => ({ runFunnelDigest: run }));
vi.mock("@/lib/cron-health", () => ({ recordCronSuccess: recordRun }));
vi.mock("@curvi/trigger/spend-alerts", () => ({ sendFounderEmail }));

const { POST } = await import("./route");

const SECRET = "funnel-digest-secret-for-tests";

function request(query = "", secret: string | null = SECRET): Request {
  return new Request(`http://localhost/api/cron/funnel-digest${query}`, {
    method: "POST",
    headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
  });
}

beforeEach(() => {
  run.mockReset();
  recordRun.mockReset();
  sendFounderEmail.mockClear();
  state.dbMode = true;
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("FOUNDER_ALERT_EMAIL", "founder@example.com");
  vi.stubEnv("OPS_EMAILS", "Founder@Curvi.ai");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/cron/funnel-digest", () => {
  it("answers 503 without a secret and 401 with a wrong or missing one", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST(request())).status).toBe(503);
    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await POST(request("", "wrong"))).status).toBe(401);
    expect((await POST(request("", null))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("skips without the database or the email settings, and records no run", async () => {
    state.dbMode = false;
    expect(await (await POST(request())).json()).toMatchObject({ ok: true, skipped: expect.any(String) });
    state.dbMode = true;
    vi.stubEnv("RESEND_API_KEY", "");
    expect(await (await POST(request())).json()).toMatchObject({ ok: true, skipped: expect.stringContaining("RESEND_API_KEY") });
    expect(run).not.toHaveBeenCalled();
    expect(recordRun).not.toHaveBeenCalled();
  });

  it("sends through the founder email path, leaving operator workspaces out, and records the run", async () => {
    run.mockImplementationOnce(async (_db, options: { send: (e: { subject: string; text: string }) => Promise<unknown> }) => {
      await options.send({ subject: "Curvi weekly funnel, week of October 12, 2026", text: "Funnel\n" });
      return { status: "sent", week: "2026-W42", subject: "Curvi weekly funnel, week of October 12, 2026" };
    });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: "sent", week: "2026-W42" });
    expect(run).toHaveBeenCalledWith(fakeDb, expect.objectContaining({ dryRun: false, operatorEmails: ["founder@curvi.ai"] }));
    expect(sendFounderEmail).toHaveBeenCalledWith({ subject: "Curvi weekly funnel, week of October 12, 2026", text: "Funnel\n" });
    expect(recordRun).toHaveBeenCalledWith(fakeDb, "funnel-digest");
  });

  it("records a run for a call that was not due or already sent", async () => {
    run.mockResolvedValueOnce({ status: "already_sent", week: "2026-W42" });
    expect((await POST(request())).status).toBe(200);
    expect(recordRun).toHaveBeenCalledTimes(1);
  });

  it("returns the composed email for a dry run, without the email settings, and records nothing", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    run.mockResolvedValueOnce({ status: "dry_run", week: "2026-W42", email: { subject: "S", text: "T" } });
    const body = await (await POST(request("?dryRun=1"))).json();
    expect(body).toEqual({ ok: true, dryRun: true, week: "2026-W42", subject: "S", text: "T" });
    expect(run).toHaveBeenCalledWith(fakeDb, expect.objectContaining({ dryRun: true }));
    expect(recordRun).not.toHaveBeenCalled();
  });

  it("answers 502 when the email was not sent and 500 when the digest throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    run.mockResolvedValueOnce({ status: "send_failed", week: "2026-W42", notice: "Resend returned status 500.", retryable: true });
    expect((await POST(request())).status).toBe(502);
    run.mockRejectedValueOnce(new Error("db down"));
    expect((await POST(request())).status).toBe(500);
    expect(recordRun).not.toHaveBeenCalled();
  });
});
