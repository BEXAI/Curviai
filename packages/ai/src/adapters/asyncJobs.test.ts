import { TEST_SPEND_CAPS as SPEND_CAPS } from "../testing/cap-policy";
/**
 * Async job adapters (BFL, fal) and result downloads with fake fetch and a
 * fake clock; nothing here touches the network. Covers Update.md 5.1: a
 * failure after a paid create is final and billed, the router never pays
 * for a second generation, the router's timeout covers the polling window,
 * and the abort signal reaches downloads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryBreakerStore } from "../breaker";
import { InMemoryCapStore, SpendCaps } from "../caps";
import { InMemoryCostMeter } from "../meter";
import { ProviderRegistry } from "../registry";
import { callWithFailover, effectiveTimeoutMs, ProviderTimeoutError, type RoutedProviderRequest } from "../router";
import { AllProvidersFailedError, ProviderError, type Provider } from "../types";
import { BFL_DEFAULT_POLL, BflFluxProvider } from "./bflFlux";
import { FAL_DEFAULT_POLL, FalGatewayProvider } from "./falGateway";
import { ASYNC_JOB_TIMEOUT_MARGIN_MS, downloadBytes, type FetchLike } from "./shared";

const PRICE = 60_000;
const POLLING_URL = "https://api.bfl.ai/v1/get_result?id=job1";

// Every adapter here gets a fake fetch; a real network call is a test bug.
beforeEach(() => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("real network access in a unit test");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A clock that moves 10 ms every time it is read. */
function steppingClock() {
  let ms = 0;
  return () => (ms += 10);
}

interface FakeBfl {
  fetchFn: FetchLike;
  creates: () => number;
  polls: () => number;
}

/** BFL fake: every create succeeds; polls answer with pollAnswer. */
function fakeBfl(pollAnswer: (signal?: AbortSignal | null) => Promise<Response>): FakeBfl {
  let creates = 0;
  let polls = 0;
  const fetchFn: FetchLike = async (_input, init) => {
    if (init?.method === "POST") {
      creates += 1;
      return jsonResponse({ id: `job${creates}`, polling_url: POLLING_URL });
    }
    polls += 1;
    return pollAnswer(init?.signal);
  };
  return { fetchFn, creates: () => creates, polls: () => polls };
}

function bfl(fetchFn: FetchLike, extra: Partial<ConstructorParameters<typeof BflFluxProvider>[0]> = {}) {
  return new BflFluxProvider({
    name: "bfl-flux",
    tasks: ["scene_plate"],
    apiKey: "test-key",
    model: "flux-2-pro",
    priceTable: { perImageMicros: PRICE },
    pollIntervalMs: 1,
    ...extra,
    fetchFn,
  });
}

function router(provider: Provider) {
  const registry = new ProviderRegistry();
  registry.register(provider);
  return {
    registry,
    routing: { scene_plate: [provider.name] },
    meter: new InMemoryCostMeter(),
    breakers: new InMemoryBreakerStore(),
  };
}

const request = { task: "scene_plate", input: { prompt: "a kitchen counter" }, jobId: "j1", stepId: "s1" };

describe("BFL adapter after a paid create", () => {
  it("reports the create as billed before polling", async () => {
    const fake = fakeBfl(async () => jsonResponse({ status: "Ready", result: { sample: "https://x.test/a.png" } }));
    const billed: number[] = [];
    const req: RoutedProviderRequest = { ...request, onBilled: (micros) => billed.push(micros) };
    const res = await bfl(fake.fetchFn).invoke(req);
    expect(res.costMicros).toBe(PRICE);
    expect(billed).toEqual([PRICE]);
  });

  it("a polling stall ends at the wall clock deadline as a final, billed failure", async () => {
    const fake = fakeBfl(async () => jsonResponse({ status: "Pending" }));
    const provider = bfl(fake.fetchFn, { pollTimeoutMs: 50, now: steppingClock() });

    const err = await provider.invoke(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    const failure = err as ProviderError;
    expect(failure.retryable).toBe(false);
    expect(failure.transient).toBe(true);
    expect(failure.billedCostMicros).toBe(PRICE);
    expect(fake.creates()).toBe(1);
    expect(fake.polls()).toBeGreaterThan(0);
    expect(fake.polls()).toBeLessThan(10);
  });

  it("a network error while polling is final and billed", async () => {
    const fake = fakeBfl(async () => {
      throw new TypeError("fetch failed");
    });
    const err = (await bfl(fake.fetchFn).invoke(request).catch((e: unknown) => e)) as ProviderError;
    expect(err.retryable).toBe(false);
    expect(err.billedCostMicros).toBe(PRICE);
  });

  it("moderation is a final content block", async () => {
    const fake = fakeBfl(async () => jsonResponse({ status: "Content Moderated" }));
    const err = (await bfl(fake.fetchFn).invoke(request).catch((e: unknown) => e)) as ProviderError;
    expect(err.code).toBe("content_blocked");
    expect(err.retryable).toBe(false);
    expect(err.transient).toBe(false);
    expect(err.billedCostMicros).toBe(PRICE);
  });

  it("a failed create is not billed and keeps the usual retry mapping", async () => {
    const fetchFn: FetchLike = async () => jsonResponse({ detail: "overloaded" }, 503);
    const billed: number[] = [];
    const req: RoutedProviderRequest = { ...request, onBilled: (micros) => billed.push(micros) };
    const err = (await bfl(fetchFn).invoke(req).catch((e: unknown) => e)) as ProviderError;
    expect(err.retryable).toBe(true);
    expect(err.billedCostMicros).toBe(0);
    expect(billed).toEqual([]);
  });

  it("through the router a polling stall pays for one create, never three", async () => {
    const fake = fakeBfl(async () => jsonResponse({ status: "Pending" }));
    const provider = bfl(fake.fetchFn, { pollTimeoutMs: 50, now: steppingClock() });
    const r = router(provider);
    const store = new InMemoryCapStore();
    const spendCaps = new SpendCaps(store, () => new Date("2026-09-28T12:00:00Z"), SPEND_CAPS);

    const err = await callWithFailover(r.registry, r.routing, r.meter, r.breakers, request, {
      sleep: async () => {},
      caps: [
        { spendCaps, capKind: "image_asset" },
        { spendCaps, capKind: "pack" },
      ],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect(fake.creates()).toBe(1);
    expect(r.meter.entries).toHaveLength(1);
    expect(r.meter.entries[0].costMicros).toBe(PRICE);
    expect(await store.get("caps:asset:image:s1")).toBe(PRICE);
    expect(await store.get("caps:pack:j1")).toBe(PRICE);
  });

  it("through the router a timeout mid poll aborts the poll and pays for one create", async () => {
    // Polls hang until the router's abort signal fires.
    const fake = fakeBfl(
      (signal) =>
        new Promise<Response>((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const provider = bfl(fake.fetchFn, { minTimeoutMs: 20 });
    const r = router(provider);

    const err = await callWithFailover(r.registry, r.routing, r.meter, r.breakers, { ...request, timeoutMs: 5 }, {
      sleep: async () => {},
    }).catch((e: unknown) => e);

    const inner = (err as AllProvidersFailedError).errors[0];
    expect(inner).toBeInstanceOf(ProviderTimeoutError);
    // The 5 ms request was raised to the adapter's 20 ms floor.
    expect(inner.message).toContain("20ms");
    expect(inner.retryable).toBe(false);
    expect(inner.billedCostMicros).toBe(PRICE);
    expect(fake.creates()).toBe(1);
    expect(r.meter.entries[0].costMicros).toBe(PRICE);
  });

  it("asks the router for its polling window plus a margin", () => {
    const fake = fakeBfl(async () => jsonResponse({ status: "Pending" }));
    const provider = new BflFluxProvider({
      name: "bfl-flux",
      tasks: ["scene_plate"],
      apiKey: "test-key",
      model: "flux-2-pro",
      priceTable: { perImageMicros: PRICE },
      fetchFn: fake.fetchFn,
    });
    expect(provider.minTimeoutMs).toBe(BFL_DEFAULT_POLL.pollTimeoutMs + ASYNC_JOB_TIMEOUT_MARGIN_MS);
    // The router's 60 s default no longer cuts a 120 s polling window short.
    expect(effectiveTimeoutMs(provider, 60_000)).toBeGreaterThan(BFL_DEFAULT_POLL.pollTimeoutMs);
  });
});

describe("fal gateway after a paid submit", () => {
  const QUEUE_URL = "https://queue.fal.run/vendor/model";

  function falFake(status: () => Promise<Response>) {
    let submits = 0;
    const fetchFn: FetchLike = async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") {
        submits += 1;
        return jsonResponse({
          request_id: "r1",
          status_url: `${QUEUE_URL}/requests/r1/status`,
          response_url: `${QUEUE_URL}/requests/r1`,
        });
      }
      if (url.endsWith("/status")) return status();
      return jsonResponse({ ok: true });
    };
    return { fetchFn, submits: () => submits };
  }

  function fal(fetchFn: FetchLike, extra: Partial<ConstructorParameters<typeof FalGatewayProvider>[0]> = {}) {
    return new FalGatewayProvider({
      name: "fal-video",
      tasks: ["video_i2v"],
      apiKey: "test-key",
      modelId: "vendor/model",
      kind: "video",
      priceTable: { perCallMicros: 500_000 },
      pollIntervalMs: 1,
      ...extra,
      fetchFn,
    });
  }

  it("a request still queued at the deadline is a final, billed failure", async () => {
    const fake = falFake(async () => jsonResponse({ status: "IN_QUEUE" }));
    const err = (await fal(fake.fetchFn, { pollTimeoutMs: 50, now: steppingClock() })
      .invoke({ task: "video_i2v", input: {} })
      .catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
    expect(err.billedCostMicros).toBe(500_000);
    expect(fake.submits()).toBe(1);
  });

  it("a 5xx while polling is final and billed", async () => {
    const fake = falFake(async () => jsonResponse({ detail: "down" }, 502));
    const err = (await fal(fake.fetchFn).invoke({ task: "video_i2v", input: {} }).catch((e: unknown) => e)) as ProviderError;
    expect(err.retryable).toBe(false);
    expect(err.transient).toBe(true);
    expect(err.billedCostMicros).toBe(500_000);
  });

  it("asks the router for its video sized polling window plus a margin", () => {
    const fake = falFake(async () => jsonResponse({ status: "IN_QUEUE" }));
    const provider = new FalGatewayProvider({
      name: "fal-video",
      tasks: ["video_i2v"],
      apiKey: "test-key",
      modelId: "vendor/model",
      kind: "video",
      priceTable: { perCallMicros: 500_000 },
      fetchFn: fake.fetchFn,
    });
    expect(provider.minTimeoutMs).toBe(FAL_DEFAULT_POLL.pollTimeoutMs + ASYNC_JOB_TIMEOUT_MARGIN_MS);
  });
});

describe("downloadBytes", () => {
  it("passes the abort signal to fetch and returns the bytes", async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const fetchFn: FetchLike = async (_input, init) => {
      seen.push(init?.signal);
      return new Response(new Uint8Array([1, 2, 3]));
    };
    const controller = new AbortController();
    const bytes = await downloadBytes(fetchFn, "https://x.test/a.png", {
      provider: "bfl-flux",
      task: "scene_plate",
      signal: controller.signal,
    });
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(seen).toEqual([controller.signal]);
  });

  it("stops when the signal aborts", async () => {
    const fetchFn: FetchLike = (_input, init) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    const controller = new AbortController();
    const pending = downloadBytes(fetchFn, "https://x.test/a.png", {
      provider: "bfl-flux",
      task: "scene_plate",
      signal: controller.signal,
    });
    controller.abort(new Error("router timeout"));
    const err = (await pending.catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("router timeout");
  });

  it("maps HTTP failures onto the usual retry rules", async () => {
    const gone = (await downloadBytes(async () => new Response("", { status: 404 }), "https://x.test/a.png", {
      provider: "bfl-flux",
      task: "scene_plate",
    }).catch((e: unknown) => e)) as ProviderError;
    expect(gone.retryable).toBe(false);
    const busy = (await downloadBytes(async () => new Response("", { status: 503 }), "https://x.test/a.png", {
      provider: "bfl-flux",
      task: "scene_plate",
    }).catch((e: unknown) => e)) as ProviderError;
    expect(busy.retryable).toBe(true);
  });
});

describe("BFL polling_url host check", () => {
  /** A BFL fake whose create hands back pollingUrl; records every GET. */
  function withPollingUrl(pollingUrl: string) {
    const gets: Array<{ url: string; key: string | undefined }> = [];
    const fetchFn: FetchLike = async (input, init) => {
      if (init?.method === "POST") return jsonResponse({ id: "job1", polling_url: pollingUrl });
      const headers = (init?.headers ?? {}) as Record<string, string>;
      gets.push({ url: String(input), key: headers["x-key"] });
      return jsonResponse({ status: "Ready", result: { sample: "https://x.test/a.png" } });
    };
    return { fetchFn, gets };
  }

  it.each([
    ["http://api.bfl.ai/v1/get_result?id=job1", "plain http"],
    ["https://evil.test/v1/get_result?id=job1", "another host"],
    ["https://evilbfl.ai/v1/get_result?id=job1", "a lookalike host"],
    ["https://api.bfl.ai.evil.test/poll", "a bfl.ai prefix on another host"],
    ["not a url", "an invalid URL"],
  ])("refuses %s (%s) without sending the key, billed and final", async (url) => {
    const fake = withPollingUrl(url);
    const err = (await bfl(fake.fetchFn)
      .invoke(request)
      .catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
    expect(err.billedCostMicros).toBe(PRICE);
    expect(fake.gets).toEqual([]);
  });

  it.each(["https://api.bfl.ai/v1/get_result?id=job1", "https://api.eu1.bfl.ai/v1/get_result?id=job1", "https://bfl.ai/poll"])(
    "polls the BFL host %s",
    async (url) => {
      const fake = withPollingUrl(url);
      const res = await bfl(fake.fetchFn).invoke(request);
      expect(res.costMicros).toBe(PRICE);
      expect(fake.gets).toEqual([{ url, key: "test-key" }]);
    },
  );

  it("polls a URL on the configured base origin", async () => {
    const url = "http://localhost:4010/v1/get_result?id=job1";
    const fake = withPollingUrl(url);
    await bfl(fake.fetchFn, { baseUrl: "http://localhost:4010" }).invoke(request);
    expect(fake.gets.map((g) => g.url)).toEqual([url]);
  });
});
