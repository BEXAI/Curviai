import { afterEach, describe, expect, it, vi } from "vitest";
import {
  httpProviderError,
  OPENAI_BILLING_ERROR_CODES,
  quotaErrorCode,
  requestJson,
  retryAfterMsFrom,
} from "./adapters/shared";
import { CircuitBreaker, InMemoryBreakerStore, processBreakerStore, QUOTA_OPEN_SECONDS } from "./breaker";
import { InMemoryCostMeter } from "./meter";
import { ProviderRegistry } from "./registry";
import { callWithFailover, ProviderTimeoutError, type ProviderQuotaInfo } from "./router";
import {
  AllProvidersFailedError,
  BreakerOpenError,
  isProviderChainUnavailable,
  isTransientChainFailure,
  ProviderError,
  type Provider,
  type ProviderRequest,
  type ProviderResponse,
} from "./types";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("quotaErrorCode", () => {
  it.each([
    [402, '{"detail":"You have exhausted the number of images in your plan"}'],
    [402, ""],
    [402, '{"detail":"Insufficient credits"}'],
    [403, '{"detail":"Insufficient credits. Buy more at dashboard"}'],
    [429, '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}'],
    [400, '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'],
    [403, '{"detail":"User is locked. Reason: Exhausted balance."}'],
    [429, '{"error":{"code":429,"message":"Your prepayment credits are depleted.","status":"RESOURCE_EXHAUSTED"}}'],
    [429, '{"error":{"code":429,"message":"Quota exceeded for metric: generate_content_requests_per_day, limit: 0","status":"RESOURCE_EXHAUSTED"}}'],
    [429, '{"error":{"message":"Credits used up","type":"insufficient_quota","code":"credit_balance_exhausted"}}'],
    [429, '{"error":{"message":"Spend limit","type":"insufficient_quota","code":"organization_spend_limit_exceeded"}}'],
    [429, '{"error":{"message":"Spend limit","type":"requests","code":"project_spend_limit_exceeded"}}'],
    [429, '{"error":{"message":"Usage limit","type":"requests","code":"organization_usage_limit_exceeded"}}'],
  ])("reads %i %s as provider_quota", (status, body) => {
    expect(quotaErrorCode(status, body)).toBe("provider_quota");
  });

  it.each([
    [429, '{"error":{"code":429,"message":"Quota exceeded for metric: requests per minute","status":"RESOURCE_EXHAUSTED"}}'],
    [429, '{"error":{"code":"rate_limit_exceeded"}}'],
    [429, '{"error":{"code":"slow_down","message":"Please slow down"}}'],
    [503, '{"error":{"code":"server_is_overloaded"}}'],
    [429, "credit_balance_exhausted in plain text is not an error code"],
    [503, "overloaded"],
    [401, "invalid key"],
    [400, "bad prompt"],
  ])("leaves %i %s alone", (status, body) => {
    expect(quotaErrorCode(status, body)).toBeUndefined();
  });

  it("makes a quota answer non retryable and non transient, even a 429", () => {
    const err = httpProviderError("openai-image", "scene_plate", 429, '{"error":{"code":"insufficient_quota"}}');
    expect(err).toMatchObject({ code: "provider_quota", retryable: false, transient: false });
    const busy = httpProviderError("openai-image", "scene_plate", 429, "slow down");
    expect(busy).toMatchObject({ code: undefined, retryable: true, transient: true });
  });

  it("never retries an OpenAI billing code, and keeps rate limits retryable with Retry-After", () => {
    for (const code of OPENAI_BILLING_ERROR_CODES) {
      const err = httpProviderError("openai:m", "intake", 429, JSON.stringify({ error: { code } }), undefined, 1000);
      expect(err).toMatchObject({ code: "provider_quota", retryable: false, transient: false, retryAfterMs: undefined });
    }
    for (const code of ["rate_limit_exceeded", "slow_down"]) {
      const err = httpProviderError("openai:m", "intake", 429, JSON.stringify({ error: { code } }), undefined, 1000);
      expect(err).toMatchObject({ code: undefined, retryable: true, transient: true, retryAfterMs: 1000 });
    }
    const bad = httpProviderError("openai:m", "intake", 400, '{"error":{"code":"invalid_value"}}', undefined, 1000);
    expect(bad).toMatchObject({ retryable: false, retryAfterMs: undefined });
    expect(bad.message).toMatch(/^openai:m responded 400: /);
  });

  it("reads Retry-After as milliseconds, seconds or an HTTP date", () => {
    expect(retryAfterMsFrom(new Headers({ "retry-after-ms": "250", "retry-after": "9" }))).toBe(250);
    expect(retryAfterMsFrom(new Headers({ "retry-after": "2" }))).toBe(2000);
    const now = Date.parse("2026-10-01T00:00:00Z");
    expect(retryAfterMsFrom(new Headers({ "retry-after": "Thu, 01 Oct 2026 00:00:05 GMT" }), now)).toBe(5000);
    expect(retryAfterMsFrom(new Headers({ "retry-after": "Thu, 01 Oct 2020 00:00:05 GMT" }), now)).toBe(0);
    expect(retryAfterMsFrom(new Headers({ "retry-after": "soon" }))).toBeUndefined();
    expect(retryAfterMsFrom(new Headers({ "retry-after": "-1" }))).toBeUndefined();
    expect(retryAfterMsFrom(new Headers())).toBeUndefined();
    expect(retryAfterMsFrom(undefined)).toBeUndefined();
  });

  it("requestJson carries the Retry-After of a retryable answer", async () => {
    const fetchFn = (async () =>
      new Response('{"error":{"code":"rate_limit_exceeded"}}', { status: 429, headers: { "retry-after": "1" } })) as typeof fetch;
    await expect(requestJson(fetchFn, "openai:m", "intake", "https://api.openai.com/v1/responses", {})).rejects.toMatchObject({
      retryable: true,
      retryAfterMs: 1000,
    });
  });

  it("keeps an adapter's own classification first", () => {
    const err = httpProviderError("x", "t", 402, "blocked", () => "content_blocked");
    expect(err.code).toBe("content_blocked");
  });

  it("requestJson throws the classified error", async () => {
    const fetchFn = (async () => new Response('{"detail":"Insufficient credits"}', { status: 402 })) as typeof fetch;
    await expect(requestJson(fetchFn, "bfl-flux", "scene_plate", "https://api.bfl.ai/x", {})).rejects.toMatchObject({
      code: "provider_quota",
      retryable: false,
    });
  });
});

describe("CircuitBreaker quota trips", () => {
  it("opens at once for the long quota cooldown and says why", async () => {
    let now = 0;
    const store = new InMemoryBreakerStore(() => now);
    const breaker = new CircuitBreaker(store);
    await breaker.tripForQuota("photo");
    expect(await breaker.openReason("photo")).toBe("quota");
    now = (QUOTA_OPEN_SECONDS - 1) * 1000;
    expect(await breaker.isOpen("photo")).toBe(true);
    now = QUOTA_OPEN_SECONDS * 1000;
    expect(await breaker.openReason("photo")).toBeNull();
  });

  it("does not shorten a quota trip when transient failures pile up", async () => {
    const store = new InMemoryBreakerStore(() => 0);
    const breaker = new CircuitBreaker(store, { failureThreshold: 1 });
    await breaker.tripForQuota("p");
    await breaker.recordFailure("p");
    expect(await breaker.openReason("p")).toBe("quota");
  });

  it("reports failures as the reason for an ordinary open", async () => {
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), { failureThreshold: 1 });
    await breaker.recordFailure("p");
    expect(await breaker.openReason("p")).toBe("failures");
  });

  it("shares one process store", () => {
    expect(processBreakerStore()).toBe(processBreakerStore());
  });
});

class ScriptedProvider implements Provider {
  readonly kind = "image" as const;
  calls = 0;
  constructor(
    readonly name: string,
    private readonly answer: () => Error | null,
  ) {}
  supports(): boolean {
    return true;
  }
  async invoke<TIn, TOut>(_req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    this.calls += 1;
    const err = this.answer();
    if (err) throw err;
    return { output: "ok" as TOut, costMicros: 5 };
  }
}

describe("callWithFailover on provider_quota", () => {
  function setup(first: () => Error | null) {
    const registry = new ProviderRegistry();
    const a = new ScriptedProvider("a", first);
    const b = new ScriptedProvider("b", () => null);
    registry.register(a);
    registry.register(b);
    const store = new InMemoryBreakerStore();
    const quota: ProviderQuotaInfo[] = [];
    const call = () =>
      callWithFailover(registry, { t: ["a", "b"] }, new InMemoryCostMeter(), store, { task: "t", input: null, jobId: "j1" }, {
        sleep: async () => {},
        onProviderQuota: (info) => {
          quota.push(info);
        },
      });
    return { a, b, store, quota, call };
  }

  it("never retries the exhausted provider, trips its breaker, logs loudly, reports it and fails over", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { a, b, store, quota, call } = setup(() =>
      httpProviderError("a", "t", 402, "You have exhausted the number of images in your plan"),
    );
    const result = await call();
    expect(result.provider).toBe("b");
    expect(a.calls).toBe(1);
    expect(await new CircuitBreaker(store).openReason("a")).toBe("quota");
    expect(quota).toEqual([{ provider: "a", task: "t", message: expect.stringContaining("402") }]);
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("provider_quota_exhausted"));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({ level: "error", event: "provider_quota_exhausted", provider: "a", task: "t", jobId: "j1" });

    // The next call skips the exhausted provider without asking it.
    await call();
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(2);
  });

  it("still retries a transient 5xx on the same provider", async () => {
    let n = 0;
    const { a, store, quota, call } = setup(() => (n++ < 1 ? httpProviderError("a", "t", 503, "overloaded") : null));
    const result = await call();
    expect(result.provider).toBe("a");
    expect(a.calls).toBe(2);
    expect(await new CircuitBreaker(store).openReason("a")).toBeNull();
    expect(quota).toEqual([]);
  });
});

describe("chain failure classes", () => {
  const busy = new ProviderError("503", "a", "t", true);
  const timeout = new ProviderTimeoutError("b", "t", 10);
  const quota = new ProviderError("402", "c", "t", false, undefined, { code: "provider_quota" });
  const open = new BreakerOpenError("d", "t");
  const bad = new ProviderError("401", "e", "t", false);
  const blocked = new ProviderError("no", "f", "t", false, undefined, { code: "content_blocked" });

  it.each([
    [[busy, timeout], true, true],
    [[busy, quota], true, true],
    [[quota, open], true, false],
    [[open], true, false],
    [[busy, bad], false, false],
    [[timeout, blocked], false, false],
    [[bad], false, false],
  ])("%#: unavailable %s, retry worthy %s", (errors, unavailable, transient) => {
    const err = new AllProvidersFailedError("t", errors as ProviderError[]);
    expect(isProviderChainUnavailable(err)).toBe(unavailable);
    expect(isTransientChainFailure(err)).toBe(transient);
  });

  it("is false for anything that is not a provider failure", () => {
    expect(isProviderChainUnavailable(new Error("x"))).toBe(false);
    expect(isTransientChainFailure(undefined)).toBe(false);
  });
});
