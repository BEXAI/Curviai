import { describe, expect, it } from "vitest";
import { InlinePackRunner, type InlinePackJob, type RequeueReason, type SettleReason } from "./inline-runner";

// The drain's restart step (docs/phases/PHASE_18.md P18-23): every job a
// shutdown stops is first offered to requeue; a job it queues is not
// settled; a running job's abort signal fires before the requeue, so the
// stopped run starts no new generation attempt; crashes and time caps are
// never requeued.

const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function harness(requeue: (payload: InlinePackJob, reason: RequeueReason, signalAborted: boolean) => Promise<boolean>) {
  const gates = new Map<string, () => void>();
  const signals = new Map<string, AbortSignal>();
  const settled: Array<{ jobId: string; reason: SettleReason }> = [];
  const offered: Array<{ jobId: string; reason: RequeueReason; aborted: boolean }> = [];
  const runner = new InlinePackRunner<InlinePackJob>(
    { concurrency: 1, shutdownGraceMs: 20, heartbeatMs: 60_000 },
    {
      runPack: async (payload, signal) => {
        signals.set(payload.jobId, signal);
        await new Promise<void>((resolve) => gates.set(payload.jobId, resolve));
      },
      settle: async (payload, reason) => {
        settled.push({ jobId: payload.jobId, reason });
      },
      requeue: async (payload, reason) => {
        const aborted = signals.get(payload.jobId)?.aborted ?? false;
        offered.push({ jobId: payload.jobId, reason, aborted });
        return requeue(payload, reason, aborted);
      },
      logger: quietLogger,
    },
  );
  return { runner, gates, signals, settled, offered };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("inline runner drain with a requeue step", () => {
  it("requeues the waiting and the interrupted job instead of settling them", async () => {
    const h = harness(async () => true);
    void h.runner.submit({ jobId: "running", workspaceId: "w", runKey: "k1" });
    void h.runner.submit({ jobId: "waiting", workspaceId: "w", runKey: "k2" });
    await tick();
    const report = await h.runner.shutdown("SIGTERM");
    expect(report).toEqual({ notStarted: 1, finished: 0, interrupted: 1, timedOut: 0, requeued: 2 });
    expect(h.offered.map((o) => [o.jobId, o.reason])).toEqual([
      ["waiting", "not_started"],
      ["running", "interrupted"],
    ]);
    expect(h.settled).toEqual([]);
  });

  it("fires a running job's abort signal before the requeue, so the stopped run starts no new provider call", async () => {
    const h = harness(async (_payload, _reason, aborted) => aborted);
    void h.runner.submit({ jobId: "running", workspaceId: "w", runKey: "k1" });
    await tick();
    expect(h.signals.get("running")?.aborted).toBe(false);
    await h.runner.shutdown("SIGTERM");
    expect(h.offered).toEqual([{ jobId: "running", reason: "interrupted", aborted: true }]);
    expect(h.settled).toEqual([]);
  });

  it("settles as before when the requeue declines or throws", async () => {
    let call = 0;
    const h = harness(async () => {
      call += 1;
      if (call === 1) return false;
      throw new Error("database gone");
    });
    void h.runner.submit({ jobId: "running", workspaceId: "w", runKey: "k1" });
    void h.runner.submit({ jobId: "waiting", workspaceId: "w", runKey: "k2" });
    await tick();
    const report = await h.runner.shutdown("SIGTERM");
    expect(report.requeued).toBe(0);
    expect(h.settled).toEqual([
      { jobId: "waiting", reason: "not_started" },
      { jobId: "running", reason: "interrupted" },
    ]);
  });

  it("offers a job submitted after the drain began as not started", async () => {
    const h = harness(async () => true);
    await h.runner.shutdown("SIGTERM");
    await h.runner.submit({ jobId: "late", workspaceId: "w", runKey: "k3" });
    expect(h.offered.map((o) => [o.jobId, o.reason])).toEqual([["late", "not_started"]]);
    expect(h.settled).toEqual([]);
  });

  it("never requeues a crash or a run past its time cap", async () => {
    const offered: string[] = [];
    const settled: SettleReason[] = [];
    const runner = new InlinePackRunner<InlinePackJob>(
      { concurrency: 2, shutdownGraceMs: 0, heartbeatMs: 60_000, maxRunMs: 30 },
      {
        runPack: async (payload) => {
          if (payload.jobId === "crash") throw new Error("boom");
          await new Promise(() => undefined);
        },
        settle: async (_payload, reason) => {
          settled.push(reason);
        },
        requeue: async (payload) => {
          offered.push(payload.jobId);
          return true;
        },
        logger: quietLogger,
      },
    );
    void runner.submit({ jobId: "crash", workspaceId: "w" });
    const hung = runner.submit({ jobId: "hung", workspaceId: "w" });
    await hung;
    expect(offered).toEqual([]);
    expect(settled.sort()).toEqual(["crashed", "timed_out"]);
  });

  it("lets a run that finishes inside the grace window finish, with nothing requeued", async () => {
    const h = harness(async () => true);
    void h.runner.submit({ jobId: "quick", workspaceId: "w", runKey: "k1" });
    await tick();
    const shutdown = h.runner.shutdown("SIGTERM");
    h.gates.get("quick")?.();
    expect(await shutdown).toEqual({ notStarted: 0, finished: 1, interrupted: 0, timedOut: 0, requeued: 0 });
    expect(h.offered).toEqual([]);
  });
});
