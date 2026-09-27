import { describe, expect, it } from "vitest";
import { InMemoryBreakerStore } from "./breaker";
import { InMemoryCapStore, SpendCaps, type CapStore } from "./caps";
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

  it("refuses a capped call on a provider without estimateCostMicros unless allowUnestimatedCost", async () => {
    // Regression for the silent cost cap bypass: maxCostMicros used to be
    // ignored whenever the provider had no estimateCostMicros.
    const p1 = new MockProvider({ name: "p1", output: "one", costMicros: 10 });
    const h = harness([p1]);

    const err = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
      sleep: h.sleep,
      maxCostMicros: 500,
    }).catch((e: AllProvidersFailedError) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    const inner = (err as AllProvidersFailedError).errors[0];
    expect(inner.message).toContain("estimateCostMicros");
    expect(inner.retryable).toBe(false);
    expect(p1.invocations).toBe(0);
    expect(h.meter.entries).toHaveLength(0);

    const allowed = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
      sleep: h.sleep,
      maxCostMicros: 500,
      allowUnestimatedCost: true,
    });
    expect(allowed.provider).toBe("p1");
    expect(p1.invocations).toBe(1);
  });

  it("caps hook reserves the estimate before invoke and releases it when the provider fails", async () => {
    const backing = new InMemoryCapStore();
    const adds: number[] = [];
    const recordingStore: CapStore = {
      get: (key) => backing.get(key),
      add: (key, delta) => {
        adds.push(delta);
        return backing.add(key, delta);
      },
    };
    const spendCaps = new SpendCaps(recordingStore);
    const p1 = new MockProvider({
      name: "p1",
      estimateMicros: 100,
      failTimes: Infinity,
      failWith: () => new ProviderError("boom", "p1", TASK, false),
    });
    const h = harness([p1]);

    await expect(
      callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
        sleep: h.sleep,
        caps: { spendCaps, capKind: "pack" },
      }),
    ).rejects.toThrow(AllProvidersFailedError);
    expect(p1.invocations).toBe(1);
    // Reserved the 100 micro estimate before invoke, released it after failure.
    expect(adds).toEqual([100, -100]);
    expect(await backing.get("caps:pack:j1")).toBe(0);
  });

  it("caps hook reconciles the reservation to the actual cost on success", async () => {
    const store = new InMemoryCapStore();
    const spendCaps = new SpendCaps(store);
    const p1 = new MockProvider({ name: "p1", estimateMicros: 100, output: "one", costMicros: 60 });
    const h = harness([p1]);

    const result = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
      sleep: h.sleep,
      caps: { spendCaps, capKind: "pack" },
    });
    expect(result.costMicros).toBe(60);
    expect(await store.get("caps:pack:j1")).toBe(60);
  });

  it("caps hook blocks the call before invoke when the reservation is over the cap", async () => {
    const spendCaps = new SpendCaps(new InMemoryCapStore());
    // The per pack cap is 8_000_000 micros; a 9_000_000 estimate must block.
    const p1 = new MockProvider({ name: "p1", estimateMicros: 9_000_000, output: "one" });
    const h = harness([p1]);

    const err = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
      sleep: h.sleep,
      caps: { spendCaps, capKind: "pack" },
    }).catch((e: AllProvidersFailedError) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect((err as AllProvidersFailedError).errors[0].message).toContain("Spend cap blocked");
    expect(p1.invocations).toBe(0);
  });

  it("layers several caps hooks: all reserve on success, all reconcile", async () => {
    const store = new InMemoryCapStore();
    const spendCaps = new SpendCaps(store);
    const p1 = new MockProvider({ name: "p1", estimateMicros: 100, output: "one", costMicros: 60 });
    const h = harness([p1]);

    const result = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
      sleep: h.sleep,
      caps: [
        { spendCaps, capKind: "pack" },
        { spendCaps, capKind: "global_day" },
      ],
      now: () => 0,
    });
    expect(result.costMicros).toBe(60);
    expect(await store.get("caps:pack:j1")).toBe(60);
    const globalKey = `caps:global:${new Date().toISOString().slice(0, 10)}`;
    expect(await store.get(globalKey)).toBe(60);
  });

  it("a blocked layer releases the layers already reserved", async () => {
    const store = new InMemoryCapStore();
    const spendCaps = new SpendCaps(store);
    // Fill the global day counter to the hard stop so the second layer blocks.
    const globalKey = `caps:global:${new Date().toISOString().slice(0, 10)}`;
    await store.add(globalKey, 150_000_000);
    const p1 = new MockProvider({ name: "p1", estimateMicros: 100, output: "one" });
    const h = harness([p1]);

    const err = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
      sleep: h.sleep,
      caps: [
        { spendCaps, capKind: "pack" },
        { spendCaps, capKind: "global_day" },
      ],
    }).catch((e: AllProvidersFailedError) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect(p1.invocations).toBe(0);
    // The pack layer's reservation was rolled back when global day blocked.
    expect(await store.get("caps:pack:j1")).toBe(0);
  });

  it("does not record breaker failures for non retryable 400 style errors", async () => {
    // Regression for breaker pollution: one workspace's bad requests used to
    // open the shared breaker for everyone.
    const bad = new MockProvider({
      name: "p1",
      failTimes: Infinity,
      failWith: () => new ProviderError("p1 responded 400: bad input", "p1", TASK, false),
    });
    const h = harness([bad]);
    const opts = { sleep: h.sleep };

    for (let i = 0; i < 7; i++) {
      await expect(callWithFailover(h.registry, h.routing, h.meter, h.store, req(), opts)).rejects.toThrow(
        AllProvidersFailedError,
      );
    }
    // Seven failed calls, one attempt each: the provider keeps being invoked
    // (breaker never opened) and no failure count was ever written.
    expect(bad.invocations).toBe(7);
    expect(await h.store.get("breaker:p1:failures")).toBeNull();
    expect(await h.store.get("breaker:p1:open")).toBeNull();
    // Non retryable errors still meter as failures.
    expect(h.meter.entries).toHaveLength(7);
    expect(h.meter.entries.every((e) => !e.ok)).toBe(true);
  });

  it("records breaker failures for retryable 500 style errors and opens at the threshold", async () => {
    const down = new MockProvider({
      name: "p1",
      failTimes: Infinity,
      failWith: () => new ProviderError("p1 responded 500: down", "p1", TASK, true),
    });
    const h = harness([down]);
    const opts = { sleep: h.sleep };

    await expect(callWithFailover(h.registry, h.routing, h.meter, h.store, req(), opts)).rejects.toThrow(
      AllProvidersFailedError,
    );
    await expect(callWithFailover(h.registry, h.routing, h.meter, h.store, req(), opts)).rejects.toThrow(
      AllProvidersFailedError,
    );
    // Two calls of three attempts each cross the threshold of five.
    expect(down.invocations).toBe(6);

    const err = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), opts).catch(
      (e: AllProvidersFailedError) => e,
    );
    expect((err as AllProvidersFailedError).errors[0]).toBeInstanceOf(BreakerOpenError);
    expect(down.invocations).toBe(6);

    // The fake clock moves past openSeconds and the provider is tried again.
    h.clock.ms += 121_000;
    await expect(callWithFailover(h.registry, h.routing, h.meter, h.store, req(), opts)).rejects.toThrow(
      AllProvidersFailedError,
    );
    expect(down.invocations).toBe(9);
  });
});
