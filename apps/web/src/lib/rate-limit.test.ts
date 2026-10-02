import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FallbackRateLimitStore,
  MemoryRateLimitStore,
  RATE_LIMIT_POLICIES,
  UpstashRateLimitStore,
  checkRateLimit,
  clientIp,
  createRateLimitStore,
  limitByIp,
  limitByUser,
  rateLimitMessage,
  type RateLimitPolicyName,
  type RateLimitStore,
  type RedisEval,
} from "./rate-limit";

// A fake Upstash client that runs the INCR plus PEXPIRE script semantics.
class FakeRedis implements RedisEval {
  readonly counters = new Map<string, { count: number; ttl: number }>();
  calls: Array<{ script: string; keys: string[]; args: unknown[] }> = [];

  async eval<TArgs extends unknown[], TData = unknown>(script: string, keys: string[], args: TArgs): Promise<TData> {
    this.calls.push({ script, keys, args });
    const key = keys[0];
    const existing = this.counters.get(key);
    const next = { count: (existing?.count ?? 0) + 1, ttl: existing?.ttl ?? Number(args[0]) };
    this.counters.set(key, next);
    return next.count as TData;
  }
}

const HOUR_MS = 3600 * 1000;
// A moment early in an hour window, so the window end is predictable.
const T0 = Math.floor(Date.UTC(2026, 8, 28, 12) / HOUR_MS) * HOUR_MS + 5 * 60 * 1000;

const backends: Array<[string, () => RateLimitStore]> = [
  ["in process", () => new MemoryRateLimitStore()],
  ["upstash", () => new UpstashRateLimitStore(new FakeRedis())],
];

describe.each(backends)("rate limits on the %s backend", (_name, makeStore) => {
  const policies = Object.keys(RATE_LIMIT_POLICIES) as RateLimitPolicyName[];

  it.each(policies)("%s allows the per user limit, then blocks with a retry time", async (policy) => {
    const store = makeStore();
    const { limit, windowSeconds } = RATE_LIMIT_POLICIES[policy].user;
    // Hour windows end 55 minutes after T0; a day window (preview.create)
    // ends at the next UTC midnight.
    const windowMs = windowSeconds * 1000;
    const windowEnd = (Math.floor(T0 / windowMs) + 1) * windowMs;
    for (let i = 0; i < limit; i += 1) {
      const decision = await checkRateLimit(policy, "user", "user:a", { store, nowMs: T0 });
      expect(decision.allowed).toBe(true);
    }
    const blocked = await checkRateLimit(policy, "user", "user:a", { store, nowMs: T0 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBe(Math.ceil((windowEnd - T0) / 1000));

    // Another user, the IP scope and another policy keep their own budgets.
    expect((await checkRateLimit(policy, "user", "user:b", { store, nowMs: T0 })).allowed).toBe(true);
    expect((await checkRateLimit(policy, "ip", "ip:1.2.3.4", { store, nowMs: T0 })).allowed).toBe(true);

    // The next window starts fresh.
    const later = await checkRateLimit(policy, "user", "user:a", { store, nowMs: T0 + windowMs });
    expect(later.allowed).toBe(true);
  });

  it("limits by IP through the route helper", async () => {
    const store = makeStore();
    const { limit } = RATE_LIMIT_POLICIES["jobs.create"].ip;
    const request = () =>
      new Request("https://curvi.ai/api/jobs", { method: "POST", headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } });
    for (let i = 0; i < limit; i += 1) {
      expect(await limitByIp(request(), "jobs.create", { store, nowMs: T0 })).toBeNull();
    }
    const response = await limitByIp(request(), "jobs.create", { store, nowMs: T0 });
    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBe(String(55 * 60));
    const body = (await response?.json()) as { error: string; reason: string };
    expect(body.reason).toBe("rate_limited");
    expect(body.error).toBe("You are going a bit fast. Try again in 55 minutes.");
  });

  it("skips the IP check when the request carries no client address", async () => {
    const store = makeStore();
    const { limit } = RATE_LIMIT_POLICIES["jobs.create"].ip;
    for (let i = 0; i <= limit + 1; i += 1) {
      expect(await limitByIp(new Request("https://curvi.ai/api/jobs", { method: "POST" }), "jobs.create", { store, nowMs: T0 })).toBeNull();
    }
  });

  it("limits by user through the route helper", async () => {
    const store = makeStore();
    const { limit } = RATE_LIMIT_POLICIES["uploads.sign"].user;
    for (let i = 0; i < limit; i += 1) {
      expect(await limitByUser("uploads.sign", "user:x", { store, nowMs: T0 })).toBeNull();
    }
    const response = await limitByUser("uploads.sign", "user:x", { store, nowMs: T0 });
    expect(response?.status).toBe(429);
    expect(Number(response?.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

describe("UpstashRateLimitStore", () => {
  it("sends one atomic script with the window key and a ttl to the window end", async () => {
    const redis = new FakeRedis();
    const store = new UpstashRateLimitStore(redis);
    await checkRateLimit("jobs.create", "user", "user:a", { store, nowMs: T0 });
    expect(redis.calls).toHaveLength(1);
    expect(redis.calls[0].script).toContain("INCR");
    expect(redis.calls[0].script).toContain("PEXPIRE");
    expect(redis.calls[0].keys[0]).toBe(`rl:jobs.create:user:user:a:${Math.floor(T0 / HOUR_MS)}`);
    expect(redis.calls[0].args[0]).toBe(55 * 60 * 1000);
  });

  it("rejects a reply that is not a number", async () => {
    const notANumber: RedisEval = {
      eval: async <_TArgs extends unknown[], TData = unknown>(): Promise<TData> => "OK" as TData,
    };
    const store = new UpstashRateLimitStore(notANumber);
    await expect(store.increment("k", 1000)).rejects.toThrow(/Unexpected/);
  });
});

describe("FallbackRateLimitStore", () => {
  it("keeps limiting in process when the shared store fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing: RateLimitStore = {
      increment: async () => {
        throw new Error("upstash down");
      },
    };
    const store = new FallbackRateLimitStore(failing, new MemoryRateLimitStore());
    const { limit } = RATE_LIMIT_POLICIES["products.create"].user;
    for (let i = 0; i < limit; i += 1) {
      expect((await checkRateLimit("products.create", "user", "user:a", { store, nowMs: T0 })).allowed).toBe(true);
    }
    expect((await checkRateLimit("products.create", "user", "user:a", { store, nowMs: T0 })).allowed).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("MemoryRateLimitStore", () => {
  it("stays bounded under a flood of distinct subjects", async () => {
    const store = new MemoryRateLimitStore(100);
    for (let i = 0; i < 1000; i += 1) {
      await store.increment(`k${i}`, HOUR_MS, T0);
    }
    expect(store.size).toBeLessThanOrEqual(100);
  });

  it("restarts a counter after it expires", async () => {
    const store = new MemoryRateLimitStore();
    expect(await store.increment("k", 1000, T0)).toBe(1);
    expect(await store.increment("k", 1000, T0 + 500)).toBe(2);
    expect(await store.increment("k", 1000, T0 + 1000)).toBe(1);
  });
});

describe("createRateLimitStore", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the in process limiter without Upstash env", () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    expect(createRateLimitStore()).toBeInstanceOf(MemoryRateLimitStore);
  });

  it("uses Upstash with an in process fallback when both env vars are set", () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    expect(createRateLimitStore()).toBeInstanceOf(FallbackRateLimitStore);
  });

  it("needs both env vars", () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    expect(createRateLimitStore()).toBeInstanceOf(MemoryRateLimitStore);
  });
});

describe("clientIp", () => {
  it("uses the last trusted forwarded hop and ignores unproved edge headers", () => {
    expect(clientIp(new Headers({ "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": "1.1.1.1" }))).toBe(
      "1.1.1.1",
    );
    expect(clientIp(new Headers({ "true-client-ip": "198.51.100.8" }))).toBe("unknown");
    expect(clientIp(new Headers({ "x-forwarded-for": " 203.0.113.9 , 10.0.0.1" }))).toBe("10.0.0.1");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("rateLimitMessage", () => {
  it("is plain spoken", () => {
    expect(rateLimitMessage(30)).toBe("You are going a bit fast. Try again in a minute.");
    expect(rateLimitMessage(61)).toBe("You are going a bit fast. Try again in 2 minutes.");
  });
});
