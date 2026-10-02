import * as Sentry from "@sentry/nextjs";
import type { ErrorEvent } from "@sentry/nextjs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { reportAlert, setAlertReport } from "@curvi/trigger/alert-report";

// docs/phases/PHASE_20.md P20-13, end to end on the real SDK: Sentry is
// initialized with this app's options and a fake DSN, and every event is
// read in beforeSend and never sent.

const mocks = vi.hoisted(() => ({
  runGeneratePack: vi.fn(),
  runPackFollowUp: vi.fn(),
  settleInterruptedJob: vi.fn(),
  claim: vi.fn(),
}));

vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@curvi/trigger/db-runtime", () => ({ resolveRuntimeDeps: () => ({}) }));
vi.mock("@curvi/trigger/runner", () => ({ runGeneratePack: mocks.runGeneratePack }));
vi.mock("@curvi/trigger/follow-up", () => ({ runPackFollowUp: mocks.runPackFollowUp }));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({
  update: () => ({ set: () => ({ where: () => ({ returning: mocks.claim }) }) }),
  execute: async () => [],
}) }));
vi.mock("@/lib/pack-maintenance", () => ({ getPackMaintenance: async () => ({ paused: false, deployPending: false, message: "" }) }));
vi.mock("@/lib/jobs/settle", () => ({
  settleInterruptedJob: mocks.settleInterruptedJob,
  deliveredCharges: vi.fn(),
  settleJob: vi.fn(),
}));

import { createInlinePackRunner } from "@/lib/jobs/enqueue";
import { InlinePackRunner, type InlinePackJob } from "@/lib/jobs/inline-runner";
import { sentryAlertReport } from "./alerts";
import { withJobScope } from "./jobs";
import { sentryInitOptions } from "./options";

const events: ErrorEvent[] = [];

const JOB = {
  jobId: "3f2b8c1e-0a4d-4c7e-9b1a-2d3e4f5a6b7c",
  workspaceId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
} as const;
const JOB_TAGS = { job_id: JOB.jobId, workspace_id: JOB.workspaceId, run_key: JOB.jobId, run_kind: "pack" };

/** Waits for the pack's run and settle, then for Sentry's queue. */
async function settled(): Promise<ErrorEvent[]> {
  await Sentry.flush(2_000);
  return events.splice(0);
}

/** A run that only ends when the runner gives up on it. */
function untilAborted(_payload: unknown, deps: { runDeadline: { signal: AbortSignal } }): Promise<void> {
  const { signal } = deps.runDeadline;
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
}

beforeAll(() => {
  const options = sentryInitOptions({
    SENTRY_DSN: "https://public@o0.ingest.sentry.io/0",
    CRON_SECRET: "cron-secret-value-0123456789",
  });
  if (!options) throw new Error("expected Sentry options");
  const scrubAndLimit = options.beforeSend as (event: ErrorEvent) => ErrorEvent | null;
  Sentry.init({
    ...options,
    beforeSend: (event) => {
      const out = scrubAndLimit(event);
      if (out) events.push(out);
      return null;
    },
  });
  setAlertReport(sentryAlertReport);
});

afterAll(async () => {
  setAlertReport(null);
  await Sentry.close(2_000);
});

beforeEach(() => {
  events.length = 0;
  mocks.claim.mockReset().mockResolvedValue([{ id: JOB.jobId }]);
  mocks.runGeneratePack.mockReset();
  mocks.runPackFollowUp.mockReset();
  mocks.settleInterruptedJob.mockReset().mockResolvedValue("failed");
  vi.stubEnv("CURVI_SHUTDOWN_GRACE_MS", "0");
  vi.stubEnv("CURVI_INLINE_PACK_CONCURRENCY", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the inline runner's reports carry the job's tags", () => {
  it("reports a database claim error and never calls a provider after a failed claim", async () => {
    mocks.claim.mockRejectedValue(new Error("runner claim unavailable"));
    await createInlinePackRunner().submit({ ...JOB } as never);
    const reported = await settled();
    expect(reported).toHaveLength(1);
    expect(reported[0].exception?.values?.[0].value).toBe("runner claim unavailable");
    expect(reported[0].tags).toMatchObject(JOB_TAGS);
    expect(mocks.runGeneratePack).not.toHaveBeenCalled();
  });
  it("reports a crash once, as an error with the job's tags", async () => {
    mocks.runGeneratePack.mockRejectedValue(new Error("pack exploded"));
    const runner = createInlinePackRunner();

    await runner.submit({ ...JOB } as never);

    const reported = await settled();
    expect(reported).toHaveLength(1);
    expect(reported[0].level).toBe("error");
    expect(reported[0].exception?.values?.[0].value).toBe("pack exploded");
    expect(reported[0].tags).toMatchObject(JOB_TAGS);
    expect(mocks.settleInterruptedJob).toHaveBeenCalledTimes(1);
    // dataCollection keeps local variables and user info out (SDK 11
    // collects both by default).
    const frames = reported[0].exception?.values?.flatMap((value) => value.stacktrace?.frames ?? []) ?? [];
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.filter((frame) => frame.vars !== undefined)).toEqual([]);
    expect(reported[0].user).toBeUndefined();
  });

  it("tags a console.error the pack code writes during the run", async () => {
    mocks.runPackFollowUp.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      console.error("[runner] shot 2 failed", new Error("provider answered 500"));
    });
    const runner = createInlinePackRunner();

    await runner.submit({ ...JOB, runKey: "follow-up-1", kind: "follow_up" } as never);

    const reported = await settled();
    expect(reported).toHaveLength(1);
    expect(reported[0].exception?.values?.[0].value).toBe("provider answered 500");
    expect(reported[0].tags).toMatchObject({ ...JOB_TAGS, run_key: "follow-up-1", run_kind: "follow_up" });
  });

  it("reports a shutdown's interrupted and not started jobs as warnings, each with its own tags", async () => {
    mocks.runGeneratePack.mockImplementation(untilAborted);
    const runner = createInlinePackRunner();
    const second = { jobId: "00000000-0000-4000-8000-000000000002", workspaceId: JOB.workspaceId };

    const running = runner.submit({ ...JOB } as never);
    const waiting = runner.submit(second as never);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runner.shutdown("SIGTERM");
    await Promise.all([running, waiting]);

    const reported = await settled();
    const byJob = new Map(reported.map((event) => [event.tags?.job_id, event]));
    expect(reported).toHaveLength(2);
    expect(byJob.get(JOB.jobId)).toMatchObject({ level: "warning", tags: { ...JOB_TAGS, settle_reason: "interrupted" } });
    expect(byJob.get(second.jobId)).toMatchObject({ level: "warning", tags: { job_id: second.jobId, settle_reason: "not_started" } });
  });

  it("reports a failed settle once, with its exception and the job's tags", async () => {
    mocks.runGeneratePack.mockRejectedValue(new Error("pack exploded again"));
    mocks.settleInterruptedJob.mockRejectedValue(new Error("database unreachable"));
    const runner = createInlinePackRunner();

    await runner.submit({ ...JOB } as never);

    const reported = await settled();
    const values = reported.map((event) => event.exception?.values?.[0].value);
    expect(values.sort()).toEqual(["database unreachable", "pack exploded again"]);
    const failure = reported.find((event) => event.exception?.values?.[0].value === "database unreachable");
    expect(failure?.tags).toMatchObject({ ...JOB_TAGS, settle_reason: "crashed", settle_failed: "true" });
  });

  it("reports a run past its time cap once, as an error with the job's tags", async () => {
    mocks.runGeneratePack.mockImplementation(untilAborted);
    const runner = createInlinePackRunner({ concurrency: 1, shutdownGraceMs: 0, heartbeatMs: 60_000, maxRunMs: 20 });

    await runner.submit({ ...JOB } as never);

    const reported = await settled();
    expect(reported).toHaveLength(1);
    expect(reported[0].level).toBe("error");
    expect(reported[0].message).toContain("time cap");
    expect(reported[0].tags).toMatchObject(JOB_TAGS);
    expect(mocks.settleInterruptedJob).toHaveBeenCalledTimes(1);
  });

  it("runs every job of a bare runner in its own context through inJobContext", async () => {
    const second = { jobId: "00000000-0000-4000-8000-000000000003", workspaceId: JOB.workspaceId };
    const runner = new InlinePackRunner<InlinePackJob>(
      { concurrency: 1, shutdownGraceMs: 0, heartbeatMs: 60_000 },
      {
        inJobContext: withJobScope,
        runPack: async (payload) => {
          await new Promise((resolve) => setTimeout(resolve, 2));
          console.error("[runner] failed a shot of job " + payload.jobId);
        },
        settle: async () => undefined,
      },
    );

    // The second job starts from the first one's finish, inside its context.
    await Promise.all([runner.submit({ ...JOB }), runner.submit(second)]);

    const reported = await settled();
    expect(reported.map((event) => event.tags?.job_id).sort()).toEqual([second.jobId, JOB.jobId].sort());
    for (const event of reported) {
      expect(event.message).toBe("[runner] failed a shot of job " + String(event.tags?.job_id));
    }
  });
});

describe("founder alerts reach Sentry as their second channel", () => {
  it("opens one issue per alert kind and period", async () => {
    reportAlert("Curvi provider spend hit the daily hard stop on 2026-10-01", { alert: "hard_stop", period: "2026-10-01" }, "error");

    const reported = await settled();
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      level: "error",
      message: "Curvi provider spend hit the daily hard stop on 2026-10-01",
      fingerprint: ["founder-alert", "hard_stop", "2026-10-01"],
      tags: { alert: "hard_stop", period: "2026-10-01", source: "founder_alert" },
    });
  });
});

describe("what leaves the server", () => {
  it("scrubs a captured console line", async () => {
    console.error("call to https://curvi.ai/api/mcp/files/tok_123?x=1 failed with cron-secret-value-0123456789");

    const reported = await settled();
    expect(reported).toHaveLength(1);
    expect(reported[0].message).toBe("call to https://curvi.ai/api/mcp/files/[token] failed with [redacted]");
    // Stack frames carry source lines of this test file, which spell the
    // secret out; everything else must not.
    const { exception, ...rest } = reported[0];
    const text = JSON.stringify({ ...rest, values: exception?.values?.map((value) => value.value) });
    expect(text).not.toContain("cron-secret-value");
    expect(text).not.toContain("tok_123");
  });

  it("sends the very same message once in a row (the SDK's dedupe)", async () => {
    for (let i = 0; i < 3; i += 1) {
      console.error("the same line three times");
    }

    expect(await settled()).toHaveLength(1);
  });

  it("sends a repeated error at most maxSameErrorPerHour times", async () => {
    for (let attempt = 1; attempt <= 25; attempt += 1) {
      console.error(`provider timed out on attempt ${attempt}`);
    }

    const reported = await settled();
    expect(reported).toHaveLength(20);
  });
});
