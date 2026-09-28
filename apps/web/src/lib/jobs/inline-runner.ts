/**
 * Inline pack runner: runs packs inside the web process when no Trigger.dev
 * worker is configured, which is how production runs on Render today.
 *
 * Two guarantees the bare after() call did not give:
 *
 * 1. A concurrency limit. At most `concurrency` packs run at once in this
 *    process; the rest wait in order, still queued in the database, so one
 *    customer starting several packs cannot run the instance out of memory
 *    and take everyone else's packs down with it. Waiting jobs heartbeat so
 *    the stale run reconciler never fails a job that is only waiting its turn.
 *
 * 2. Graceful shutdown. On SIGTERM (every deploy, restart or spin down) the
 *    runner stops taking new work, settles every job that has not started,
 *    gives the running packs a grace window to finish, then settles whatever
 *    is still running. Settling marks the job failed through the existing
 *    failure path and releases its credit hold, so a deploy never leaves a
 *    job stuck in a working state until the 30 minute reconciler finds it.
 *
 * The class is pure: the pack run, the settle step and the heartbeat are
 * injected, so tests drive it without a database or a pipeline.
 */

export interface InlinePackJob {
  jobId: string;
  workspaceId: string;
}

/** Why the runner settled a job itself instead of the pack run finishing it. */
export type SettleReason = "crashed" | "not_started" | "interrupted";

export interface InlineRunnerConfig {
  /** Packs allowed to run at once in this process. */
  concurrency: number;
  /** How long a shutdown waits for running packs before settling them. Keep
   * it below the host's shutdown delay (Render: maxShutdownDelaySeconds,
   * 30 seconds unless changed), or the process is killed before it settles. */
  shutdownGraceMs: number;
  /** How often waiting jobs bump updated_at while they wait their turn. */
  heartbeatMs: number;
}

export interface InlineRunnerLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface InlineRunnerDeps<P extends InlinePackJob> {
  /** Runs one pack to its end. The pack runner owns its own failure handling;
   * a rejection here is treated as a crash and the job is settled. */
  runPack: (payload: P) => Promise<void>;
  /** Marks a job this runner will not finish as failed (never touching a job
   * that already finished) and releases its credit hold. */
  settle: (payload: P, reason: SettleReason) => Promise<void>;
  /** Bumps updated_at on jobs still waiting for a slot. */
  heartbeat?: (jobIds: string[]) => Promise<void>;
  logger?: InlineRunnerLogger;
}

export interface InlineRunnerStats {
  concurrency: number;
  running: number;
  waiting: number;
  draining: boolean;
}

export interface ShutdownReport {
  /** Jobs that were waiting for a slot and were settled without running. */
  notStarted: number;
  /** Running packs that finished inside the grace window. */
  finished: number;
  /** Running packs still going when the grace window ended, then settled. */
  interrupted: number;
}

/** Thrown by assertAccepting once a shutdown has begun. */
export class InlineRunnerClosedError extends Error {
  constructor() {
    super("This server is shutting down and is not accepting new packs.");
    this.name = "InlineRunnerClosedError";
  }
}

export const DEFAULT_INLINE_PACK_CONCURRENCY = 1;
export const MAX_INLINE_PACK_CONCURRENCY = 16;
export const DEFAULT_SHUTDOWN_GRACE_MS = 20_000;
/** Render allows at most 300 seconds between SIGTERM and SIGKILL; the grace
 * window leaves ten seconds of that for settling and exiting. */
export const MAX_SHUTDOWN_GRACE_MS = 290_000;
export const DEFAULT_QUEUE_HEARTBEAT_MS = 60_000;

function intInRange(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return fallback;
  }
  const value = Number(raw.trim());
  return Math.min(max, Math.max(min, value));
}

/**
 * Reads the runner settings from the environment:
 * CURVI_INLINE_PACK_CONCURRENCY (default 1, the safe value for a 512 MB
 * instance) and CURVI_SHUTDOWN_GRACE_MS (default 20000, inside Render's
 * default 30 second shutdown delay). Invalid values fall back to the default;
 * out of range values are clamped.
 */
export function readInlineRunnerConfig(read: (name: string) => string | undefined): InlineRunnerConfig {
  return {
    concurrency: intInRange(
      read("CURVI_INLINE_PACK_CONCURRENCY"),
      DEFAULT_INLINE_PACK_CONCURRENCY,
      1,
      MAX_INLINE_PACK_CONCURRENCY,
    ),
    shutdownGraceMs: intInRange(read("CURVI_SHUTDOWN_GRACE_MS"), DEFAULT_SHUTDOWN_GRACE_MS, 0, MAX_SHUTDOWN_GRACE_MS),
    heartbeatMs: DEFAULT_QUEUE_HEARTBEAT_MS,
  };
}

interface Entry<P> {
  payload: P;
  /** The pack run, once started. */
  run: Promise<void> | null;
  /** True once the entry is resolved: finished, crashed and settled, or
   * settled by a shutdown. */
  finished: boolean;
  resolve: () => void;
  done: Promise<void>;
}

function createEntry<P>(payload: P): Entry<P> {
  let resolve: () => void = () => undefined;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  return { payload, run: null, finished: false, resolve, done };
}

export class InlinePackRunner<P extends InlinePackJob> {
  private readonly waiting: Array<Entry<P>> = [];
  private readonly running = new Map<string, Entry<P>>();
  private draining = false;
  private shutdownPromise: Promise<ShutdownReport> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly logger: InlineRunnerLogger;

  constructor(
    readonly config: InlineRunnerConfig,
    private readonly deps: InlineRunnerDeps<P>,
  ) {
    this.logger = deps.logger ?? console;
  }

  get accepting(): boolean {
    return !this.draining;
  }

  stats(): InlineRunnerStats {
    return {
      concurrency: this.config.concurrency,
      running: this.running.size,
      waiting: this.waiting.length,
      draining: this.draining,
    };
  }

  /** Throws InlineRunnerClosedError once a shutdown has begun, so the caller
   * can refuse the job through its own failure path before responding. */
  assertAccepting(): void {
    if (this.draining) {
      throw new InlineRunnerClosedError();
    }
  }

  /**
   * Queues a pack. The returned promise resolves once the job is finished or
   * settled, and never rejects, so it is safe to hand to after(). A job that
   * arrives after shutdown began is settled at once instead of run.
   */
  submit(payload: P): Promise<void> {
    const existing = this.running.get(payload.jobId) ?? this.waiting.find((e) => e.payload.jobId === payload.jobId);
    if (existing) {
      // The same job twice runs once; the second caller waits on the first.
      return existing.done;
    }
    const entry = createEntry(payload);
    if (this.draining) {
      void this.settleEntry(entry, "not_started");
      return entry.done;
    }
    this.waiting.push(entry);
    this.pump();
    return entry.done;
  }

  /**
   * Stops taking work, settles waiting jobs, waits up to the grace window for
   * running packs, then settles the ones still running. Safe to call more
   * than once; later calls return the first shutdown's report.
   */
  shutdown(signal = "shutdown"): Promise<ShutdownReport> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.draining = true;
    this.stopHeartbeat();
    this.shutdownPromise = this.drain(signal);
    return this.shutdownPromise;
  }

  private async drain(signal: string): Promise<ShutdownReport> {
    const notStarted = this.waiting.splice(0);
    const inFlight = [...this.running.values()];
    this.logger.info(
      `[jobs] ${signal}: inline runner draining with ${inFlight.length} running and ${notStarted.length} waiting`,
    );
    await Promise.all(notStarted.map((entry) => this.settleEntry(entry, "not_started")));

    if (inFlight.length > 0 && this.config.shutdownGraceMs > 0) {
      await settleWithin(
        Promise.allSettled(inFlight.map((entry) => entry.run ?? Promise.resolve())),
        this.config.shutdownGraceMs,
      );
    }

    const stillRunning = inFlight.filter((entry) => !entry.finished);
    await Promise.all(stillRunning.map((entry) => this.settleEntry(entry, "interrupted")));
    const report: ShutdownReport = {
      notStarted: notStarted.length,
      finished: inFlight.length - stillRunning.length,
      interrupted: stillRunning.length,
    };
    this.logger.info(
      `[jobs] ${signal}: inline runner drained (${report.finished} finished, ${report.interrupted} interrupted, ${report.notStarted} not started)`,
    );
    return report;
  }

  private pump(): void {
    while (!this.draining && this.running.size < this.config.concurrency && this.waiting.length > 0) {
      const entry = this.waiting.shift();
      if (entry) {
        this.start(entry);
      }
    }
    this.syncHeartbeat();
  }

  private start(entry: Entry<P>): void {
    const { jobId } = entry.payload;
    this.running.set(jobId, entry);
    entry.run = (async () => {
      try {
        await this.deps.runPack(entry.payload);
      } catch (err) {
        this.logger.error(`[jobs] inline pack run crashed for job ${jobId}`, err);
        await this.settleEntry(entry, "crashed");
      }
    })().finally(() => {
      if (this.running.get(jobId) === entry) {
        this.running.delete(jobId);
      }
      this.finish(entry);
      this.pump();
    });
  }

  private async settleEntry(entry: Entry<P>, reason: SettleReason): Promise<void> {
    if (entry.finished) {
      return;
    }
    try {
      await this.deps.settle(entry.payload, reason);
    } catch (err) {
      this.logger.error(`[jobs] could not settle job ${entry.payload.jobId} (${reason})`, err);
    } finally {
      this.finish(entry);
    }
  }

  private finish(entry: Entry<P>): void {
    if (!entry.finished) {
      entry.finished = true;
      entry.resolve();
    }
  }

  private syncHeartbeat(): void {
    const needed = !this.draining && this.waiting.length > 0 && Boolean(this.deps.heartbeat);
    if (needed && !this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => void this.beat(), this.config.heartbeatMs);
      this.heartbeatTimer.unref?.();
    } else if (!needed) {
      this.stopHeartbeat();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async beat(): Promise<void> {
    const ids = this.waiting.map((entry) => entry.payload.jobId);
    if (ids.length === 0 || !this.deps.heartbeat) {
      return;
    }
    try {
      await this.deps.heartbeat(ids);
    } catch (err) {
      this.logger.warn(`[jobs] heartbeat for ${ids.length} waiting jobs failed`, err);
    }
  }
}

/** Resolves when `work` settles or after `ms`, whichever comes first. */
async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  try {
    await Promise.race([work.then(() => undefined), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

type ShutdownSignal = "SIGTERM" | "SIGINT";

const globalScope = globalThis as typeof globalThis & {
  __curviInlinePackRunner?: InlinePackRunner<InlinePackJob>;
};

export interface InstallOptions {
  /** Hooks SIGTERM and SIGINT to shutdown(). Off in tests. */
  handleSignals?: boolean;
  /** Exits the process once the shutdown finished. Needed only when nothing
   * else exits it: Next.js exits by itself after awaiting after() work unless
   * NEXT_MANUAL_SIG_HANDLE is set. */
  exitAfterShutdown?: boolean;
}

/**
 * Returns the process wide runner, creating it on first use. The runner lives
 * on globalThis because Next.js bundles route handlers separately, and one
 * process must have exactly one concurrency limit and one shutdown hook.
 */
export function installInlinePackRunner<P extends InlinePackJob>(
  create: () => InlinePackRunner<P>,
  opts: InstallOptions = {},
): InlinePackRunner<P> {
  const existing = globalScope.__curviInlinePackRunner;
  if (existing) {
    return existing as unknown as InlinePackRunner<P>;
  }
  const runner = create();
  globalScope.__curviInlinePackRunner = runner as unknown as InlinePackRunner<InlinePackJob>;
  if (opts.handleSignals) {
    const onSignal = (signal: ShutdownSignal): void => {
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);
      void runner.shutdown(signal).finally(() => {
        if (opts.exitAfterShutdown) {
          process.exit(0);
        }
      });
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  }
  return runner;
}

/** The process wide runner if one was created, without creating it. */
export function currentInlinePackRunner(): InlinePackRunner<InlinePackJob> | null {
  return globalScope.__curviInlinePackRunner ?? null;
}

/** Test helper: forgets the process wide runner. Signal hooks stay bound to
 * the old runner, so tests install with handleSignals off. */
export function resetInlinePackRunnerForTests(): void {
  delete globalScope.__curviInlinePackRunner;
}
