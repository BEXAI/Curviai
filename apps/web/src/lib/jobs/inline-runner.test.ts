import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INLINE_PACK_CONCURRENCY,
  DEFAULT_SHUTDOWN_GRACE_MS,
  InlinePackRunner,
  InlineRunnerClosedError,
  MAX_INLINE_PACK_CONCURRENCY,
  MAX_SHUTDOWN_GRACE_MS,
  currentInlinePackRunner,
  installInlinePackRunner,
  readInlineRunnerConfig,
  resetInlinePackRunnerForTests,
  type InlinePackJob,
  type InlineRunnerConfig,
  type SettleReason,
} from "./inline-runner";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  let reject: (err: unknown) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** A runner whose packs finish only when the test says so. */
function harness(config: Partial<InlineRunnerConfig> = {}) {
  const gates = new Map<string, Deferred>();
  const started: string[] = [];
  const settled: Array<{ jobId: string; reason: SettleReason }> = [];
  const heartbeats: string[][] = [];
  let maxRunning = 0;
  let running = 0;
  const gate = (jobId: string): Deferred => {
    let d = gates.get(jobId);
    if (!d) {
      d = deferred();
      gates.set(jobId, d);
    }
    return d;
  };
  const runner = new InlinePackRunner<InlinePackJob>(
    { concurrency: 2, shutdownGraceMs: 50, heartbeatMs: 60_000, ...config },
    {
      runPack: async (payload) => {
        started.push(payload.jobId);
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        try {
          await gate(payload.jobId).promise;
        } finally {
          running -= 1;
        }
      },
      settle: async (payload, reason) => {
        settled.push({ jobId: payload.jobId, reason });
      },
      heartbeat: async (jobIds) => {
        heartbeats.push(jobIds);
      },
      logger: quietLogger,
    },
  );
  return {
    runner,
    started,
    settled,
    heartbeats,
    gate,
    maxRunning: () => maxRunning,
    job: (id: string): InlinePackJob => ({ jobId: id, workspaceId: "ws" }),
  };
}

/** Lets pending promise callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

afterEach(() => {
  vi.useRealTimers();
  resetInlinePackRunnerForTests();
});

describe("readInlineRunnerConfig", () => {
  it("uses small safe defaults with no env", () => {
    const config = readInlineRunnerConfig(() => undefined);
    expect(config.concurrency).toBe(DEFAULT_INLINE_PACK_CONCURRENCY);
    expect(config.concurrency).toBeLessThanOrEqual(2);
    expect(config.shutdownGraceMs).toBe(DEFAULT_SHUTDOWN_GRACE_MS);
    // Render's default shutdown delay is 30 seconds; the default grace must
    // leave room to settle jobs before the kill.
    expect(config.shutdownGraceMs).toBeLessThan(30_000);
  });

  it("reads and clamps the env values, ignoring junk", () => {
    const env: Record<string, string> = {
      CURVI_INLINE_PACK_CONCURRENCY: "3",
      CURVI_SHUTDOWN_GRACE_MS: "240000",
    };
    expect(readInlineRunnerConfig((n) => env[n])).toMatchObject({ concurrency: 3, shutdownGraceMs: 240_000 });

    env.CURVI_INLINE_PACK_CONCURRENCY = "500";
    env.CURVI_SHUTDOWN_GRACE_MS = "999999";
    expect(readInlineRunnerConfig((n) => env[n])).toMatchObject({
      concurrency: MAX_INLINE_PACK_CONCURRENCY,
      shutdownGraceMs: MAX_SHUTDOWN_GRACE_MS,
    });

    env.CURVI_INLINE_PACK_CONCURRENCY = "0";
    expect(readInlineRunnerConfig((n) => env[n]).concurrency).toBe(1);

    env.CURVI_INLINE_PACK_CONCURRENCY = "two";
    env.CURVI_SHUTDOWN_GRACE_MS = "-5";
    expect(readInlineRunnerConfig((n) => env[n])).toMatchObject({
      concurrency: DEFAULT_INLINE_PACK_CONCURRENCY,
      shutdownGraceMs: DEFAULT_SHUTDOWN_GRACE_MS,
    });
  });
});

describe("InlinePackRunner concurrency limit", () => {
  it("never runs more packs than the limit and starts waiting jobs in order", async () => {
    const h = harness({ concurrency: 2 });
    const done = ["a", "b", "c", "d"].map((id) => h.runner.submit(h.job(id)));
    await flush();

    expect(h.started).toEqual(["a", "b"]);
    expect(h.runner.stats()).toMatchObject({ running: 2, waiting: 2, draining: false });

    h.gate("b").resolve();
    await done[1];
    await flush();
    expect(h.started).toEqual(["a", "b", "c"]);

    h.gate("a").resolve();
    h.gate("c").resolve();
    h.gate("d").resolve();
    await Promise.all(done);

    expect(h.started).toEqual(["a", "b", "c", "d"]);
    expect(h.maxRunning()).toBe(2);
    expect(h.runner.stats()).toMatchObject({ running: 0, waiting: 0 });
    expect(h.settled).toEqual([]);
  });

  it("runs a job submitted twice only once", async () => {
    const h = harness({ concurrency: 1 });
    const first = h.runner.submit(h.job("a"));
    const second = h.runner.submit(h.job("a"));
    await flush();
    h.gate("a").resolve();
    await Promise.all([first, second]);
    expect(h.started).toEqual(["a"]);
  });

  it("settles a crashed pack and keeps the queue moving", async () => {
    const h = harness({ concurrency: 1 });
    const a = h.runner.submit(h.job("a"));
    const b = h.runner.submit(h.job("b"));
    await flush();
    h.gate("a").reject(new Error("boom"));
    await a;
    expect(h.settled).toEqual([{ jobId: "a", reason: "crashed" }]);
    await flush();
    expect(h.started).toEqual(["a", "b"]);
    h.gate("b").resolve();
    await b;
  });

  it("resolves the submit promise even when settling fails", async () => {
    const runner = new InlinePackRunner<InlinePackJob>(
      { concurrency: 1, shutdownGraceMs: 10, heartbeatMs: 60_000 },
      {
        runPack: async () => {
          throw new Error("crash");
        },
        settle: async () => {
          throw new Error("database down");
        },
        logger: quietLogger,
      },
    );
    await expect(runner.submit({ jobId: "a", workspaceId: "ws" })).resolves.toBeUndefined();
  });

  it("heartbeats only the jobs that are waiting for a slot", async () => {
    vi.useFakeTimers();
    const h = harness({ concurrency: 1, heartbeatMs: 1_000 });
    h.runner.submit(h.job("a"));
    h.runner.submit(h.job("b"));
    h.runner.submit(h.job("c"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.heartbeats).toEqual([["b", "c"]]);

    h.gate("a").resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.heartbeats[1]).toEqual(["c"]);

    h.gate("b").resolve();
    await vi.advanceTimersByTimeAsync(0);
    const count = h.heartbeats.length;
    // Nothing waits any more, so the timer stops.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.heartbeats.length).toBe(count);
    h.gate("c").resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe("InlinePackRunner shutdown", () => {
  it("stops taking work, settles waiting jobs, and lets fast packs finish", async () => {
    const h = harness({ concurrency: 1, shutdownGraceMs: 1_000 });
    const a = h.runner.submit(h.job("a"));
    const b = h.runner.submit(h.job("b"));
    await flush();

    const shutdown = h.runner.shutdown("SIGTERM");
    expect(h.runner.accepting).toBe(false);
    expect(() => h.runner.assertAccepting()).toThrow(InlineRunnerClosedError);
    await b;
    expect(h.settled).toEqual([{ jobId: "b", reason: "not_started" }]);

    // The running pack finishes inside the grace window: nothing to settle.
    h.gate("a").resolve();
    await a;
    await expect(shutdown).resolves.toEqual({ notStarted: 1, finished: 1, interrupted: 0 });
    expect(h.started).toEqual(["a"]);
    expect(h.settled).toEqual([{ jobId: "b", reason: "not_started" }]);
  });

  it("settles packs still running when the grace window ends", async () => {
    const h = harness({ concurrency: 2, shutdownGraceMs: 30 });
    const a = h.runner.submit(h.job("a"));
    const b = h.runner.submit(h.job("b"));
    await flush();

    const report = await h.runner.shutdown("SIGTERM");

    expect(report).toEqual({ notStarted: 0, finished: 0, interrupted: 2 });
    expect(h.settled).toEqual([
      { jobId: "a", reason: "interrupted" },
      { jobId: "b", reason: "interrupted" },
    ]);
    // after() waits on these; they resolve without waiting for the packs.
    await expect(Promise.all([a, b])).resolves.toBeDefined();
    expect(h.runner.stats().draining).toBe(true);

    // A pack that finishes late is not settled a second time.
    h.gate("a").resolve();
    await flush();
    expect(h.settled).toHaveLength(2);
  });

  it("settles a job submitted after shutdown began instead of running it", async () => {
    const h = harness();
    await h.runner.shutdown("SIGTERM");
    await h.runner.submit(h.job("late"));
    expect(h.started).toEqual([]);
    expect(h.settled).toEqual([{ jobId: "late", reason: "not_started" }]);
  });

  it("returns the same report when shutdown is called twice", async () => {
    const h = harness();
    const first = h.runner.shutdown("SIGTERM");
    const second = h.runner.shutdown("SIGINT");
    expect(second).toBe(first);
    await first;
  });

  it("with no grace window settles running packs at once", async () => {
    const h = harness({ concurrency: 1, shutdownGraceMs: 0 });
    h.runner.submit(h.job("a"));
    await flush();
    await expect(h.runner.shutdown()).resolves.toEqual({ notStarted: 0, finished: 0, interrupted: 1 });
    expect(h.settled).toEqual([{ jobId: "a", reason: "interrupted" }]);
  });
});

describe("installInlinePackRunner", () => {
  it("creates one runner per process and exposes it without creating one", () => {
    expect(currentInlinePackRunner()).toBeNull();
    const create = vi.fn(() => harness().runner);
    const first = installInlinePackRunner(create);
    const second = installInlinePackRunner(create);
    expect(second).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
    expect(currentInlinePackRunner()).toBe(first);
  });

  it("drains on SIGTERM when signal handling is on", async () => {
    const h = harness({ concurrency: 1, shutdownGraceMs: 0 });
    const beforeTerm = process.listenerCount("SIGTERM");
    const beforeInt = process.listenerCount("SIGINT");
    installInlinePackRunner(() => h.runner, { handleSignals: true });
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);
    h.runner.submit(h.job("a"));
    await flush();

    process.emit("SIGTERM", "SIGTERM");
    await flush();

    expect(h.runner.accepting).toBe(false);
    expect(h.settled).toEqual([{ jobId: "a", reason: "interrupted" }]);
    // Both hooks come off after the first signal.
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
  });
});
