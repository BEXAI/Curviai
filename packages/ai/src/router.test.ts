import { describe, expect, it } from "vitest";
import { InMemoryBreakerStore } from "./breaker";
import { InMemoryCostMeter } from "./meter";
import { ProviderRegistry } from "./registry";
import { backoffDelayMs, callWithFailover, DEFAULT_RETRY_OPTIONS, ProviderTimeoutError } from "./router";
import { MockProvider } from "./testing";
import { AllProvidersFailedError, BreakerOpenError, ProviderError, type ProviderRequest } from "./types";

const TASK = "generate_image";

function harness(providers: MockProvider[]) {
  const registry = new ProviderRegistry();
  for (const p of providers) registry.register(p);
  const routing = { [TASK]: providers.map((p) => p.name) };
  const meter = new InMemoryCostMeter();
  const clock = { ms: 0 };
  const store = new InMemoryBreakerStore(() => clock.ms);
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { registry, routing, meter, store, clock, sleeps, sleep };
}

function req(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return { task: TASK, input: { prompt: "a mug on a table" }, workspaceId: "w1", jobId: "j1", ...overrides };
}

describe("callWithFailover", () => {
  it("returns the first provider's result when it succeeds", async () => {
    const p1 = new MockProvider({ name: "p1", output: "one", costMicros: 10 });
    const p2 = new MockProvider({ name: "p2", output: "two", costMicros: 20 });
    const h = harness([p1, p2]);

    const result = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), { sleep: h.sleep });
    expect(result.provider).toBe("p1");
    expect(result.output).toBe("one");
    expect(result.costMicros).toBe(10);
    expect(result.attempts).toBe(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(p2.invocations).toBe(0);
  });

  it("respects the failover chain order", async () => {
    const fail = (name: string) =>
      new MockProvider({
        name,
        failTimes: Infinity,
        failWith: () => new ProviderError("hard fail", name, TASK, false),
      });
    const p1 = fail("p1");
    const p2 = fail("p2");
    const p3 = new MockProvider({ name: "p3", output: "three", costMicros: 5 });
    const h = harness([p1, p2, p3]);

    const result = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), { sleep: h.sleep });
    expect(result.provider).toBe("p3");
    expect(p1.invocations).toBe(1);
    expect(p2.invocations).toBe(1);
    expect(p3.invocations).toBe(1);
    expect(h.meter.entries.map((e) => e.provider)).toEqual(["p1", "p2", "p3"]);
    expect(result.attempts).toBe(3);
  });

  it("retries with exponential backoff and jitter, then fails over", async () => {
    const p1 = new MockProvider({ name: "p1", failTimes: Infinity });
    const p2 = new MockProvider({ name: "p2", output: "two", costMicros: 7 });
    const h = harness([p1, p2]);

    const result = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
      sleep: h.sleep,
      random: () => 1,
      retry: { retries: 2, baseDelayMs: 100, maxDelayMs: 4000 },
    });
    expect(p1.invocations).toBe(3);
    expect(h.sleeps).toEqual([100, 200]);
    expect(result.provider).toBe("p2");
    expect(result.attempts).toBe(4);
  });

  it("caps backoff at maxDelayMs and applies half to full jitter", () => {
    const retry = { retries: 5, baseDelayMs: 100, maxDelayMs: 300 };
    expect(backoffDelayMs(0, retry, () => 1)).toBe(100);
    expect(backoffDelayMs(1, retry, () => 1)).toBe(200);
    expect(backoffDelayMs(2, retry, () => 1)).toBe(300);
    expect(backoffDelayMs(0, retry, () => 0)).toBe(50);
  });

  it("does not retry errors marked not retryable", async () => {
    const p1 = new MockProvider({
      name: "p1",
      failTimes: Infinity,
      failWith: () => new ProviderError("bad request", "p1", TASK, false),
    });
    const p2 = new MockProvider({ name: "p2", output: "two" });
    const h = harness([p1, p2]);

    await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), { sleep: h.sleep });
    expect(p1.invocations).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it("meters every attempt with cost and ok flag", async () => {
    const p1 = new MockProvider({ name: "p1", failTimes: 1, output: "one", costMicros: 123 });
    const h = harness([p1]);

    await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), { sleep: h.sleep });
    expect(h.meter.entries).toHaveLength(2);
    const [failed, succeeded] = h.meter.entries;
    expect(failed.ok).toBe(false);
    expect(failed.costMicros).toBe(0);
    expect(failed.error).toContain("mock failure");
    expect(failed.attempt).toBe(1);
    expect(failed.workspaceId).toBe("w1");
    expect(failed.jobId).toBe("j1");
    expect(succeeded.ok).toBe(true);
    expect(succeeded.costMicros).toBe(123);
    expect(succeeded.attempt).toBe(2);
    expect(h.meter.totalForJob("j1")).toBe(123);
  });

  it("opens the breaker after 5 failures, skips the provider, then allows after 120s", async () => {
    const p1 = new MockProvider({ name: "p1", failTimes: Infinity });
    const p2 = new MockProvider({ name: "p2", output: "two" });
    const h = harness([p1, p2]);
    const opts = { sleep: h.sleep };

    await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), opts);
    expect(p1.invocations).toBe(3);
    await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), opts);
    expect(p1.invocations).toBe(6);

    const third = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), opts);
    expect(p1.invocations).toBe(6);
    expect(third.provider).toBe("p2");
    expect(third.attempts).toBe(1);

    h.clock.ms += 121_000;
    await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), opts);
    expect(p1.invocations).toBe(9);
  });

  it("surfaces BreakerOpenError in the aggregate when the only provider is open", async () => {
    const p1 = new MockProvider({ name: "p1", failTimes: Infinity });
    const h = harness([p1]);
    const opts = { sleep: h.sleep };

    await expect(callWithFailover(h.registry, h.routing, h.meter, h.store, req(), opts)).rejects.toThrow(
      AllProvidersFailedError,
    );
    await expect(callWithFailover(h.registry, h.routing, h.meter, h.store, req(), opts)).rejects.toThrow(
      AllProvidersFailedError,
    );
    const err = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), opts).catch(
      (e: AllProvidersFailedError) => e,
    );
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect((err as AllProvidersFailedError).errors[0]).toBeInstanceOf(BreakerOpenError);
    expect(p1.invocations).toBe(6);
  });

  it("treats a timeout as retryable and succeeds on the retry", async () => {
    const p1 = new MockProvider({ name: "p1", hangTimes: 1, output: "late", costMicros: 9 });
    const h = harness([p1]);

    const result = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
      sleep: h.sleep,
      timeoutMs: 25,
    });
    expect(result.output).toBe("late");
    expect(result.attempts).toBe(2);
    expect(h.meter.entries[0].ok).toBe(false);
    expect(h.meter.entries[0].error).toContain("timed out");
  });

  it("fails over on repeated timeouts and reports ProviderTimeoutError", async () => {
    const p1 = new MockProvider({ name: "p1", hangTimes: Infinity });
    const p2 = new MockProvider({ name: "p2", output: "two" });
    const h = harness([p1, p2]);

    const result = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
      sleep: h.sleep,
      timeoutMs: 10,
      retry: { retries: 1 },
    });
    expect(result.provider).toBe("p2");
    expect(p1.invocations).toBe(2);

    const only = harness([new MockProvider({ name: "p1", hangTimes: Infinity })]);
    const err = await callWithFailover(only.registry, only.routing, only.meter, only.store, req(), {
      sleep: only.sleep,
      timeoutMs: 10,
      retry: { retries: 0 },
    }).catch((e: AllProvidersFailedError) => e);
    expect((err as AllProvidersFailedError).errors[0]).toBeInstanceOf(ProviderTimeoutError);
  });

  it("rejects on estimated cost above maxCostMicros before invoking", async () => {
    const p1 = new MockProvider({ name: "p1", estimateMicros: 1_000, output: "pricey" });
    const p2 = new MockProvider({ name: "p2", estimateMicros: 100, output: "cheap", costMicros: 100 });
    const h = harness([p1, p2]);

    const result = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
      sleep: h.sleep,
      maxCostMicros: 500,
    });
    expect(p1.invocations).toBe(0);
    expect(result.provider).toBe("p2");

    const solo = harness([new MockProvider({ name: "p1", estimateMicros: 1_000 })]);
    const err = await callWithFailover(solo.registry, solo.routing, solo.meter, solo.store, req(), {
      sleep: solo.sleep,
      maxCostMicros: 500,
    }).catch((e: AllProvidersFailedError) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect((err as AllProvidersFailedError).errors[0].message).toContain("maxCostMicros");
    expect(solo.meter.entries).toHaveLength(0);
  });

  it("aggregates every provider error in AllProvidersFailedError", async () => {
    const p1 = new MockProvider({
      name: "p1",
      failTimes: Infinity,
      failWith: () => new ProviderError("p1 down", "p1", TASK, false),
    });
    const p2 = new MockProvider({
      name: "p2",
      failTimes: Infinity,
      failWith: () => new ProviderError("p2 down", "p2", TASK, false),
    });
    const h = harness([p1, p2]);

    const err = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), { sleep: h.sleep }).catch(
      (e: AllProvidersFailedError) => e,
    );
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    const failure = err as AllProvidersFailedError;
    expect(failure.task).toBe(TASK);
    expect(failure.errors.map((e) => e.provider)).toEqual(["p1", "p2"]);
    expect(failure.message).toContain("p1 down");
    expect(failure.message).toContain("p2 down");
  });

  it("skips unregistered and unsupporting providers with recorded errors", async () => {
    const p2 = new MockProvider({ name: "p2", tasks: ["other_task"] });
    const p3 = new MockProvider({ name: "p3", output: "three" });
    const registry = new ProviderRegistry();
    registry.register(p2);
    registry.register(p3);
    const routing = { [TASK]: ["ghost", "p2", "p3"] };
    const meter = new InMemoryCostMeter();
    const store = new InMemoryBreakerStore(() => 0);

    const result = await callWithFailover(registry, routing, meter, store, req());
    expect(result.provider).toBe("p3");
    expect(p2.invocations).toBe(0);
  });

  it("throws a clear error when the task has no routing entry", async () => {
    const h = harness([new MockProvider({ name: "p1" })]);
    await expect(
      callWithFailover(h.registry, {}, h.meter, h.store, req({ task: "unrouted" })),
    ).rejects.toThrow(/No providers routed/);
  });

  it("uses default retry options when none are given", () => {
    expect(DEFAULT_RETRY_OPTIONS.retries).toBe(2);
  });
});
