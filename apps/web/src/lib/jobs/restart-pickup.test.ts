import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deployRestarts } from "@curvi/pipeline/seed";
import type { GeneratePackInput } from "@curvi/trigger/runner";

// scheduleRestartPickup (docs/phases/PHASE_18.md P18-23): throttled per
// process, only for inline packs with a database, never on a draining
// instance, and the claimed packs run inside the request's after() so
// Next.js waits for them on SIGTERM.

const afterMock = vi.hoisted(() => vi.fn());
vi.mock("next/server", () => ({ after: afterMock }));
const claim = vi.hoisted(() => vi.fn());
const switchOn = vi.hoisted(() => vi.fn(async () => true));
vi.mock("./restart", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./restart")>()),
  claimRestartedJobs: claim,
  deployRestartsOn: switchOn,
}));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({ marker: "db" }) }));

import { resetRestartPickupForTests, scheduleRestartPickup } from "./enqueue";
import { InlinePackRunner, installInlinePackRunner, resetInlinePackRunnerForTests, type InlinePackJob } from "./inline-runner";

const payload = (jobId: string) => ({ jobId, workspaceId: "ws", runKey: `key-${jobId}` }) as unknown as GeneratePackInput;

function fakeRunner() {
  const ran: string[] = [];
  const runner = installInlinePackRunner(
    () =>
      new InlinePackRunner<InlinePackJob>(
        { concurrency: 2, shutdownGraceMs: 0, heartbeatMs: 60_000 },
        {
          runPack: async (p) => {
            ran.push(p.jobId);
          },
          settle: async () => undefined,
          logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        },
      ),
  );
  return { runner, ran };
}

beforeEach(() => {
  afterMock.mockReset();
  claim.mockReset();
  resetRestartPickupForTests();
  resetInlinePackRunnerForTests();
  vi.stubEnv("TRIGGER_SECRET_KEY", "");
  vi.stubEnv("DATABASE_URL", "postgres://user:pw@db.example.test:6543/postgres");
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetInlinePackRunnerForTests();
});

describe("scheduleRestartPickup", () => {
  it("needs a database and ignores the retired Trigger.dev key", () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(scheduleRestartPickup()).toBe(false);
    vi.stubEnv("DATABASE_URL", "postgres://x");
    vi.stubEnv("TRIGGER_SECRET_KEY", "tr_secret");
    expect(afterMock).not.toHaveBeenCalled();
    expect(scheduleRestartPickup({ force: true })).toBe(true);
    expect(afterMock).toHaveBeenCalledOnce();
  });

  it("looks at most once per the seeded interval, unless forced", () => {
    const now = 1_000_000;
    expect(scheduleRestartPickup({ now })).toBe(true);
    expect(scheduleRestartPickup({ now: now + deployRestarts.pickupIntervalSeconds * 1000 - 1 })).toBe(false);
    expect(scheduleRestartPickup({ now: now + 1, force: true })).toBe(true);
    expect(scheduleRestartPickup({ now: now + 1 + deployRestarts.pickupIntervalSeconds * 1000 })).toBe(true);
    expect(afterMock).toHaveBeenCalledTimes(3);
  });

  it("skips outside a request scope without using up the interval", () => {
    afterMock.mockImplementationOnce(() => {
      throw new Error("`after` was called outside a request scope");
    });
    expect(scheduleRestartPickup({ now: 5 })).toBe(false);
    expect(scheduleRestartPickup({ now: 6 })).toBe(true);
  });

  it("claims the restarts after the response and runs each on this instance", async () => {
    const { ran } = fakeRunner();
    claim.mockResolvedValueOnce([payload("a"), payload("b")]);
    expect(scheduleRestartPickup()).toBe(true);
    const task = afterMock.mock.calls[0][0] as () => Promise<void>;
    await task();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(ran.sort()).toEqual(["a", "b"]);
  });

  it("claims nothing while the deploy_restarts_enabled switch is off (P18-23 ships off)", async () => {
    fakeRunner();
    switchOn.mockResolvedValueOnce(false);
    expect(scheduleRestartPickup()).toBe(true);
    const task = afterMock.mock.calls[0][0] as () => Promise<void>;
    await task();
    expect(claim).not.toHaveBeenCalled();
  });

  it("never looks on a draining instance", async () => {
    const { runner } = fakeRunner();
    await runner.shutdown("SIGTERM");
    expect(scheduleRestartPickup({ force: true })).toBe(false);
    expect(claim).not.toHaveBeenCalled();
  });
});
