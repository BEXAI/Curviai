import { describe, expect, it } from "vitest";
import { InMemoryBreakerStore } from "./breaker";
import { InMemoryCapStore, SpendCaps, type CapStore } from "./caps";
import { InMemoryCostMeter } from "./meter";
import { ProviderRegistry } from "./registry";
import {
  backoffDelayMs,
  callWithFailover,
  DEFAULT_RETRY_OPTIONS,
  DEFAULT_TIMEOUT_MS,
  effectiveTimeoutMs,
  ProviderTimeoutError,
} from "./router";
import { MockProvider } from "./testing";
import {
  AllProvidersFailedError,
  billedMicrosOf,
  BreakerOpenError,
  CapStoreUnavailableError,
  hasProviderErrorCode,
  ProviderError,
  type CostMeterEntry,
  type ProviderRequest,
} from "./types";

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
    expect(result.billedFailureMicros).toBe(0);
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

  it("walks a per call chain in place of the routing table entry", async () => {
    const p1 = new MockProvider({ name: "p1", output: "one", failTimes: Infinity });
    const p2 = new MockProvider({ name: "p2", output: "two" });
    const p3 = new MockProvider({ name: "p3", output: "three" });
    const h = harness([p1, p2, p3]);

    const result = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
      sleep: h.sleep,
      chain: ["ghost", "p3", "p2"],
    });
    expect(result.provider).toBe("p3");
    expect(p1.invocations).toBe(0);
    expect(p2.invocations).toBe(0);
  });

  it("fails over along a per call chain and falls back to routing when it is empty", async () => {
    const p1 = new MockProvider({ name: "p1", output: "one" });
    const p2 = new MockProvider({
      name: "p2",
      failTimes: Infinity,
      failWith: () => new ProviderError("down", "p2", TASK, false),
    });
    const p3 = new MockProvider({ name: "p3", output: "three" });
    const h = harness([p1, p2, p3]);

    const failedOver = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
      sleep: h.sleep,
      chain: ["p2", "p3"],
    });
    expect(failedOver.provider).toBe("p3");
    const routed = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), { sleep: h.sleep, chain: [] });
    expect(routed.provider).toBe("p1");
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

const DAY = "2026-09-28";
const GLOBAL_KEY = `caps:global:${DAY}`;
const fixedClock = () => new Date(`${DAY}T12:00:00Z`);

function capsOn(store: CapStore = new InMemoryCapStore()) {
  return new SpendCaps(store, fixedClock);
}

function internalErrors() {
  const seen: Array<{ context: string; err: unknown }> = [];
  return { seen, onInternalError: (err: unknown, context: string) => seen.push({ context, err }) };
}

describe("billed failures: a timeout after a paid create never pays again (Update.md 5.1)", () => {
  it("does not retry a timeout after a billed async create, meters it and keeps it against the caps", async () => {
    const store = new InMemoryCapStore();
    const spendCaps = capsOn(store);
    const p1 = new MockProvider({ name: "p1", estimateMicros: 60_000, reportBilledMicros: 60_000, hangTimes: Infinity });
    const p2 = new MockProvider({ name: "p2", estimateMicros: 50_000, output: "two", costMicros: 50_000 });
    const h = harness([p1, p2]);

    const result = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
      sleep: h.sleep,
      timeoutMs: 10,
      caps: [
        { spendCaps, capKind: "pack" },
        { spendCaps, capKind: "global_day" },
      ],
    });

    expect(result.provider).toBe("p2");
    // The caller sees the failed attempt's billed spend next to the winner's.
    expect(result.costMicros).toBe(50_000);
    expect(result.billedFailureMicros).toBe(60_000);
    // One paid create on p1, never a second one.
    expect(p1.invocations).toBe(1);
    expect(h.sleeps).toEqual([]);
    const [failed, succeeded] = h.meter.entries;
    expect(failed.provider).toBe("p1");
    expect(failed.ok).toBe(false);
    expect(failed.costMicros).toBe(60_000);
    expect(failed.errorCode).toBe("timeout");
    expect(succeeded.costMicros).toBe(50_000);
    expect(h.meter.totalForJob("j1")).toBe(110_000);
    // The billed spend stays on the caps instead of being released.
    expect(await store.get("caps:pack:j1")).toBe(110_000);
    expect(await store.get(GLOBAL_KEY)).toBe(110_000);
  });

  it("reports the billed total of a failed chain on AllProvidersFailedError and billedMicrosOf", async () => {
    const p1 = new MockProvider({ name: "p1", reportBilledMicros: 60_000, failTimes: Infinity });
    const p2 = new MockProvider({
      name: "p2",
      failTimes: Infinity,
      failWith: () => new ProviderError("declined", "p2", TASK, false, undefined, { code: "content_blocked", billedCostMicros: 1_500 }),
    });
    const p3 = new MockProvider({ name: "p3", failTimes: Infinity });
    const h = harness([p1, p2, p3]);

    const err = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), { sleep: h.sleep }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect((err as AllProvidersFailedError).billedCostMicros).toBe(61_500);
    expect(billedMicrosOf(err)).toBe(61_500);
    // The meter recorded the same spend.
    expect(h.meter.totalForJob("j1")).toBe(61_500);
    expect(billedMicrosOf((err as AllProvidersFailedError).errors[1])).toBe(1_500);
    expect(billedMicrosOf(new Error("plain"))).toBe(0);
  });

  it("sums the errors when an AllProvidersFailedError is built without a total", () => {
    const billed = new ProviderError("x", "p1", TASK, false, undefined, { billedCostMicros: 700 });
    const plain = new ProviderError("y", "p2", TASK, true);
    expect(new AllProvidersFailedError(TASK, [billed, plain]).billedCostMicros).toBe(700);
    expect(new AllProvidersFailedError(TASK, []).billedCostMicros).toBe(0);
    expect(new AllProvidersFailedError(TASK, [billed], 900).billedCostMicros).toBe(900);
  });

  it("reports the billed timeout as a non retryable ProviderTimeoutError", async () => {
    const p1 = new MockProvider({ name: "p1", reportBilledMicros: 60_000, hangTimes: Infinity });
    const h = harness([p1]);

    const err = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
      sleep: h.sleep,
      timeoutMs: 10,
    }).catch((e: AllProvidersFailedError) => e);

    expect(err).toBeInstanceOf(AllProvidersFailedError);
    const inner = (err as AllProvidersFailedError).errors[0];
    expect(inner).toBeInstanceOf(ProviderTimeoutError);
    expect(inner.retryable).toBe(false);
    expect(inner.billedCostMicros).toBe(60_000);
    expect(inner.message).toContain("not retrying");
    expect(p1.invocations).toBe(1);
  });

  it("does not retry a network error that follows a billed create", async () => {
    const p1 = new MockProvider({ name: "p1", reportBilledMicros: 40_000, failTimes: Infinity });
    const h = harness([p1]);

    const err = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), { sleep: h.sleep }).catch(
      (e: AllProvidersFailedError) => e,
    );

    const inner = (err as AllProvidersFailedError).errors[0];
    expect(inner.retryable).toBe(false);
    expect(inner.billedCostMicros).toBe(40_000);
    expect(p1.invocations).toBe(1);
    expect(h.meter.entries).toHaveLength(1);
    expect(h.meter.entries[0].costMicros).toBe(40_000);
  });

  it("still counts billed stalls toward the breaker so a struggling provider stops being paid", async () => {
    const p1 = new MockProvider({ name: "p1", reportBilledMicros: 60_000, hangTimes: Infinity });
    const p2 = new MockProvider({ name: "p2", output: "two" });
    const h = harness([p1, p2]);
    const opts = { sleep: h.sleep, timeoutMs: 5 };

    for (let i = 0; i < 5; i++) {
      await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), opts);
    }
    expect(p1.invocations).toBe(5);
    const sixth = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), opts);
    expect(sixth.provider).toBe("p2");
    // The breaker opened: the sixth call paid nothing to p1.
    expect(p1.invocations).toBe(5);
  });

  it("an unbilled timeout stays retryable", async () => {
    const p1 = new MockProvider({ name: "p1", hangTimes: 1, output: "late" });
    const h = harness([p1]);

    const result = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
      sleep: h.sleep,
      timeoutMs: 10,
    });
    expect(result.attempts).toBe(2);
    expect(h.meter.entries[0].costMicros).toBe(0);
  });

  it("raises the per attempt timeout to the provider's minTimeoutMs", async () => {
    const slow = new MockProvider({ name: "p1", latencyMs: 40, minTimeoutMs: 2_000, output: "done" });
    const h = harness([slow]);
    const result = await callWithFailover(h.registry, h.routing, h.meter, h.store, req({ timeoutMs: 5 }), {
      sleep: h.sleep,
    });
    expect(result.output).toBe("done");
    expect(result.attempts).toBe(1);

    // Without the floor the same provider times out at the requested 5 ms.
    const unfloored = new MockProvider({ name: "p1", latencyMs: 40, output: "done" });
    const u = harness([unfloored]);
    const err = await callWithFailover(u.registry, u.routing, u.meter, u.store, req({ timeoutMs: 5 }), {
      sleep: u.sleep,
      retry: { retries: 0 },
    }).catch((e: AllProvidersFailedError) => e);
    expect((err as AllProvidersFailedError).errors[0]).toBeInstanceOf(ProviderTimeoutError);
  });

  it("effectiveTimeoutMs only ever raises the requested timeout", () => {
    const floored = new MockProvider({ name: "p1", minTimeoutMs: 150_000 });
    const plain = new MockProvider({ name: "p2" });
    expect(effectiveTimeoutMs(floored, DEFAULT_TIMEOUT_MS)).toBe(150_000);
    expect(effectiveTimeoutMs(floored, 200_000)).toBe(200_000);
    expect(effectiveTimeoutMs(plain, DEFAULT_TIMEOUT_MS)).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe("content blocks and empty replies (Update.md 5.4)", () => {
  const blocked = (billed = 0, retryable = false) =>
    new MockProvider({
      name: "p1",
      estimateMicros: 1_000,
      failTimes: Infinity,
      failWith: () =>
        new ProviderError("declined", "p1", TASK, retryable, undefined, {
          code: "content_blocked",
          billedCostMicros: billed,
        }),
    });

  it("never retries a content block, never touches the shared breaker, and fails over", async () => {
    // retryable true on purpose: even a mislabeled block must not burn retries.
    const p1 = blocked(0, true);
    const p2 = new MockProvider({ name: "p2", output: "two" });
    const h = harness([p1, p2]);

    for (let i = 0; i < 7; i++) {
      const result = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), { sleep: h.sleep });
      expect(result.provider).toBe("p2");
    }
    expect(p1.invocations).toBe(7);
    expect(h.sleeps).toEqual([]);
    expect(await h.store.get("breaker:p1:failures")).toBeNull();
    expect(await h.store.get("breaker:p1:open")).toBeNull();
    const p1Entries = h.meter.entries.filter((e) => e.provider === "p1");
    expect(p1Entries).toHaveLength(7);
    expect(p1Entries.every((e) => !e.ok && e.errorCode === "content_blocked")).toBe(true);
  });

  it("meters a billed block and keeps it against the caps", async () => {
    const store = new InMemoryCapStore();
    const spendCaps = capsOn(store);
    const h = harness([blocked(1_234)]);

    const err = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
      sleep: h.sleep,
      caps: { spendCaps, capKind: "pack" },
    }).catch((e: unknown) => e);

    expect(hasProviderErrorCode(err, "content_blocked")).toBe(true);
    expect(h.meter.entries).toHaveLength(1);
    expect(h.meter.entries[0].costMicros).toBe(1_234);
    expect(h.meter.totalForJob("j1")).toBe(1_234);
    // Reserved 1_000, billed 1_234: the shortfall is charged, nothing released.
    expect(await store.get("caps:pack:j1")).toBe(1_234);
  });

  it("does not retry an empty reply or count it toward the breaker", async () => {
    const p1 = new MockProvider({
      name: "p1",
      failTimes: Infinity,
      failWith: () => new ProviderError("no image", "p1", TASK, false, undefined, { code: "empty_output" }),
    });
    const h = harness([p1]);

    const err = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), { sleep: h.sleep }).catch(
      (e: unknown) => e,
    );
    expect(hasProviderErrorCode(err, "empty_output")).toBe(true);
    expect(hasProviderErrorCode(err, "content_blocked")).toBe(false);
    expect(p1.invocations).toBe(1);
    expect(await h.store.get("breaker:p1:failures")).toBeNull();
  });
});

describe("estimate and reserve errors stay inside the failover chain (Update.md 5.5)", () => {
  it("fails over when a provider's estimate throws", async () => {
    const store = new InMemoryCapStore();
    const spendCaps = capsOn(store);
    const p1 = new MockProvider({
      name: "p1",
      estimate: () => {
        throw new Error("no price table for model x");
      },
    });
    const p2 = new MockProvider({ name: "p2", estimateMicros: 100, output: "two", costMicros: 80 });
    const h = harness([p1, p2]);

    const result = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
      sleep: h.sleep,
      caps: { spendCaps, capKind: "pack" },
    });
    expect(result.provider).toBe("p2");
    expect(p1.invocations).toBe(0);
    expect(await store.get("caps:pack:j1")).toBe(80);

    const solo = harness([p1]);
    const err = await callWithFailover(solo.registry, solo.routing, solo.meter, solo.store, req(), {
      sleep: solo.sleep,
      maxCostMicros: 1_000,
    }).catch((e: AllProvidersFailedError) => e);
    const inner = (err as AllProvidersFailedError).errors[0];
    expect(inner.code).toBe("estimate_failed");
    expect(inner.message).toContain("no price table");
  });

  it("refuses an estimate that is not a finite, non negative number", async () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const p1 = new MockProvider({ name: "p1", estimate: () => bad });
      const h = harness([p1]);
      const err = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
        sleep: h.sleep,
        maxCostMicros: 1_000,
      }).catch((e: AllProvidersFailedError) => e);
      expect((err as AllProvidersFailedError).errors[0].code).toBe("estimate_failed");
      expect(p1.invocations).toBe(0);
    }
  });

  it("a reserve error on a later layer releases the layers already held and fails over", async () => {
    const backing = new InMemoryCapStore();
    let globalFailures = 1;
    const flaky: CapStore = {
      get: (key) => backing.get(key),
      add: async (key, delta) => {
        if (key === GLOBAL_KEY && globalFailures > 0) {
          globalFailures -= 1;
          throw new Error("connection reset");
        }
        return backing.add(key, delta);
      },
    };
    const spendCaps = capsOn(flaky);
    const p1 = new MockProvider({ name: "p1", estimateMicros: 100, output: "one", costMicros: 100 });
    const p2 = new MockProvider({ name: "p2", estimateMicros: 100, output: "two", costMicros: 80 });
    const h = harness([p1, p2]);

    const result = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
      sleep: h.sleep,
      caps: [
        { spendCaps, capKind: "pack" },
        { spendCaps, capKind: "global_day" },
      ],
    });

    expect(result.provider).toBe("p2");
    expect(p1.invocations).toBe(0);
    // p1's pack layer was released when its global layer threw; only p2's
    // actual spend remains on either counter.
    expect(await backing.get("caps:pack:j1")).toBe(80);
    expect(await backing.get(GLOBAL_KEY)).toBe(80);
  });

  it("fails closed with CapStoreUnavailableError when the cap store is down", async () => {
    const down: CapStore = {
      get: async () => {
        throw new Error("database unavailable");
      },
      add: async () => {
        throw new Error("database unavailable");
      },
    };
    const spendCaps = capsOn(down);
    const p1 = new MockProvider({ name: "p1", estimateMicros: 100 });
    const p2 = new MockProvider({ name: "p2", estimateMicros: 100 });
    const h = harness([p1, p2]);

    const err = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
      sleep: h.sleep,
      caps: { spendCaps, capKind: "global_day" },
    }).catch((e: AllProvidersFailedError) => e);

    expect(err).toBeInstanceOf(AllProvidersFailedError);
    const errors = (err as AllProvidersFailedError).errors;
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e instanceof CapStoreUnavailableError)).toBe(true);
    expect(errors[0].code).toBe("cap_unavailable");
    // Callers that route cap blocks to needs review keep matching it.
    expect(errors[0].message.startsWith("Spend cap blocked")).toBe(true);
    expect(errors[0].message).toContain("database unavailable");
    expect(p1.invocations + p2.invocations).toBe(0);
  });

  it("fails closed when a caps layer lacks its identifier", async () => {
    const spendCaps = capsOn();
    const p1 = new MockProvider({ name: "p1", estimateMicros: 100 });
    const h = harness([p1]);

    const err = await callWithFailover(h.registry, h.routing, h.meter, h.store, req({ jobId: undefined }), {
      sleep: h.sleep,
      caps: { spendCaps, capKind: "pack" },
    }).catch((e: AllProvidersFailedError) => e);
    expect((err as AllProvidersFailedError).errors[0]).toBeInstanceOf(CapStoreUnavailableError);
    expect(p1.invocations).toBe(0);
  });
});

describe("success bookkeeping never retries or double releases (Update.md 5.6)", () => {
  it("a release that throws during reconcile leaves totals non negative and pays once", async () => {
    const backing = new InMemoryCapStore();
    let throwOnce = true;
    const flaky: CapStore = {
      get: (key) => backing.get(key),
      add: async (key, delta) => {
        if (key === "caps:pack:j1" && delta < 0 && throwOnce) {
          throwOnce = false;
          throw new Error("write timeout");
        }
        return backing.add(key, delta);
      },
    };
    const spendCaps = capsOn(flaky);
    const p1 = new MockProvider({ name: "p1", estimateMicros: 100, output: "one", costMicros: 60 });
    const h = harness([p1]);
    const internal = internalErrors();

    const result = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
      sleep: h.sleep,
      onInternalError: internal.onInternalError,
      caps: [
        { spendCaps, capKind: "pack" },
        { spendCaps, capKind: "global_day" },
      ],
    });

    expect(result.output).toBe("one");
    expect(p1.invocations).toBe(1);
    // The failed release keeps the pack at its reservation (never below
    // zero, never released twice); the global layer still reconciled.
    expect(await backing.get("caps:pack:j1")).toBe(100);
    expect(await backing.get(GLOBAL_KEY)).toBe(60);
    expect(internal.seen.map((s) => s.context)).toEqual(["release caps:pack:j1"]);
  });

  it("a meter that throws after a paid success still invokes the provider once", async () => {
    const store = new InMemoryCapStore();
    const spendCaps = capsOn(store);
    const p1 = new MockProvider({ name: "p1", estimateMicros: 100, output: "one", costMicros: 60 });
    const h = harness([p1]);
    const brokenMeter = {
      record: (_entry: CostMeterEntry) => {
        throw new Error("meter table missing");
      },
    };
    const internal = internalErrors();

    const result = await callWithFailover(h.registry, h.routing, brokenMeter, h.store, req(), {
      sleep: h.sleep,
      onInternalError: internal.onInternalError,
      caps: { spendCaps, capKind: "pack" },
    });

    expect(result.output).toBe("one");
    expect(result.attempts).toBe(1);
    expect(p1.invocations).toBe(1);
    // Reconciled to the actual cost, not released in full.
    expect(await store.get("caps:pack:j1")).toBe(60);
    expect(internal.seen.map((s) => s.context)).toEqual(["meter.record success"]);
  });

  it("a breaker store that throws on success does not retry the paid call", async () => {
    const p1 = new MockProvider({ name: "p1", output: "one", costMicros: 60 });
    const h = harness([p1]);
    const flakyBreaker = {
      get: (key: string) => h.store.get(key),
      incr: (key: string, ttl: number) => h.store.incr(key, ttl),
      set: async () => {
        throw new Error("redis down");
      },
    };
    const internal = internalErrors();

    const result = await callWithFailover(h.registry, h.routing, h.meter, flakyBreaker, req(), {
      sleep: h.sleep,
      onInternalError: internal.onInternalError,
    });
    expect(result.output).toBe("one");
    expect(p1.invocations).toBe(1);
    expect(internal.seen.map((s) => s.context)).toEqual(["breaker.recordSuccess"]);
  });

  it("a meter that throws on a failed attempt does not abort the failover", async () => {
    const p1 = new MockProvider({
      name: "p1",
      failTimes: Infinity,
      failWith: () => new ProviderError("bad input", "p1", TASK, false),
    });
    const p2 = new MockProvider({ name: "p2", output: "two" });
    const h = harness([p1, p2]);
    let calls = 0;
    const flakyMeter = {
      record: () => {
        calls += 1;
        if (calls === 1) throw new Error("meter write failed");
      },
    };

    const result = await callWithFailover(h.registry, h.routing, flakyMeter, h.store, req(), {
      sleep: h.sleep,
      onInternalError: () => {},
    });
    expect(result.provider).toBe("p2");
  });
});

describe("spend alert hook (Update.md 5.7)", () => {
  async function run(opts: {
    preload?: Record<string, number>;
    estimate: number;
    cost: number;
    layers?: Array<"global_day" | "pack">;
    onCapAlert?: (total: number) => void | Promise<void>;
    onInternalError?: (err: unknown, context: string) => void;
  }) {
    const store = new InMemoryCapStore();
    for (const [key, micros] of Object.entries(opts.preload ?? {})) {
      await store.add(key, micros);
    }
    const spendCaps = capsOn(store);
    // An LLM call: the alert covers every provider kind, not only images.
    const p1 = new MockProvider({
      name: "p1",
      kind: "llm",
      estimateMicros: opts.estimate,
      output: "ok",
      costMicros: opts.cost,
    });
    const h = harness([p1]);
    const alerts: number[] = [];
    const result = await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
      sleep: h.sleep,
      caps: (opts.layers ?? ["global_day"]).map((capKind) => ({ spendCaps, capKind })),
      onCapAlert: opts.onCapAlert ?? ((total) => void alerts.push(total)),
      onInternalError: opts.onInternalError,
    }).catch((e: unknown) => e);
    return { store, alerts, result, p1 };
  }

  it("calls onCapAlert with the global total when an allowed reservation reaches the alert line", async () => {
    const { alerts, result } = await run({ preload: { [GLOBAL_KEY]: 49_990_000 }, estimate: 20_000, cost: 20_000 });
    expect((result as { output: unknown }).output).toBe("ok");
    expect(alerts).toEqual([50_010_000]);
  });

  it("stays quiet below the alert line", async () => {
    const { alerts } = await run({ preload: { [GLOBAL_KEY]: 10_000_000 }, estimate: 20_000, cost: 20_000 });
    expect(alerts).toEqual([]);
  });

  it("does not alert when the global reservation is blocked at the hard stop", async () => {
    const { alerts, result, p1 } = await run({
      preload: { [GLOBAL_KEY]: 150_000_000 },
      estimate: 20_000,
      cost: 20_000,
    });
    expect(result).toBeInstanceOf(AllProvidersFailedError);
    expect(p1.invocations).toBe(0);
    expect(alerts).toEqual([]);
  });

  it("does not alert when another layer blocks the call", async () => {
    const { alerts, result, store } = await run({
      preload: { [GLOBAL_KEY]: 60_000_000, "caps:pack:j1": 8_000_000 },
      estimate: 20_000,
      cost: 20_000,
      layers: ["global_day", "pack"],
    });
    expect(result).toBeInstanceOf(AllProvidersFailedError);
    expect(alerts).toEqual([]);
    // The global layer was released when the pack layer blocked.
    expect(await store.get(GLOBAL_KEY)).toBe(60_000_000);
  });

  it("alerts when charging a shortfall moves the total past the line", async () => {
    const { alerts, store } = await run({ preload: { [GLOBAL_KEY]: 49_990_000 }, estimate: 1_000, cost: 20_000 });
    expect(await store.get(GLOBAL_KEY)).toBe(50_010_000);
    expect(alerts).toEqual([50_010_000]);
  });

  it("alerts once per call, not again for the shortfall", async () => {
    const { alerts } = await run({ preload: { [GLOBAL_KEY]: 55_000_000 }, estimate: 1_000, cost: 20_000 });
    expect(alerts).toEqual([55_001_000]);
  });

  it("a throwing or rejecting notifier never breaks the call", async () => {
    const internal = internalErrors();
    const thrown = await run({
      preload: { [GLOBAL_KEY]: 55_000_000 },
      estimate: 1_000,
      cost: 1_000,
      onCapAlert: () => {
        throw new Error("email down");
      },
      onInternalError: internal.onInternalError,
    });
    expect((thrown.result as { output: unknown }).output).toBe("ok");

    const rejected = await run({
      preload: { [GLOBAL_KEY]: 55_000_000 },
      estimate: 1_000,
      cost: 1_000,
      onCapAlert: async () => {
        throw new Error("email rejected");
      },
      onInternalError: internal.onInternalError,
    });
    expect((rejected.result as { output: unknown }).output).toBe("ok");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(internal.seen.map((s) => s.context)).toEqual(["onCapAlert", "onCapAlert"]);
  });

  it("dedupes to one founder notice a day with claimGlobalDayAlert", async () => {
    const store = new InMemoryCapStore();
    await store.add(GLOBAL_KEY, 55_000_000);
    const spendCaps = capsOn(store);
    const p1 = new MockProvider({ name: "p1", estimateMicros: 1_000, output: "ok", costMicros: 1_000 });
    const h = harness([p1]);
    const notices: number[] = [];
    const onCapAlert = async (total: number) => {
      if (await spendCaps.claimGlobalDayAlert()) notices.push(total);
    };

    for (let i = 0; i < 4; i++) {
      await callWithFailover(h.registry, h.routing, h.meter, h.store, req(), {
        sleep: h.sleep,
        caps: { spendCaps, capKind: "global_day" },
        onCapAlert,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notices).toEqual([55_001_000]);
  });
});
