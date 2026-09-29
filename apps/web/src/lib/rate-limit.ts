/**
 * Request rate limits for the write routes that cost storage or credits:
 * upload signing and completion, job creation and product creation (plan 4.1
 * and 4.5). Each route is limited twice, by client IP before any auth work
 * and by the signed in user after it, and answers 429 with Retry-After.
 *
 * Backend (Phase 10 decision 5): Upstash Redis when UPSTASH_REDIS_REST_URL
 * and UPSTASH_REDIS_REST_TOKEN are set, so every instance shares one counter;
 * an in process limiter otherwise. If Upstash errors at request time the
 * in process limiter takes over for that request, so an outage never blocks
 * customers and never removes the limit entirely.
 *
 * Counting is a fixed window per policy, scope and subject. The window index
 * is part of the key, so a counter can never outlive its window.
 */

import { Redis } from "@upstash/redis";
import { NextResponse } from "next/server";
import { optionalEnv } from "@/lib/env";
import { getSessionUser } from "@/lib/supabase/server";

export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

export interface RateLimitPolicy {
  /** Per signed in user (or per workspace when no user id is available). */
  user: RateLimitRule;
  /** Per client IP, checked before authentication. */
  ip: RateLimitRule;
}

const HOUR = 3600;

/**
 * Named policies. The IP limits are looser than the user limits because a
 * team, an agency office or a mobile carrier can share one address.
 */
export const RATE_LIMIT_POLICIES = {
  "uploads.sign": { user: { limit: 200, windowSeconds: HOUR }, ip: { limit: 400, windowSeconds: HOUR } },
  "uploads.complete": { user: { limit: 200, windowSeconds: HOUR }, ip: { limit: 400, windowSeconds: HOUR } },
  // The preflight at upload: one per photo, again when the note changes.
  "uploads.preflight": { user: { limit: 200, windowSeconds: HOUR }, ip: { limit: 400, windowSeconds: HOUR } },
  // Brand colors from a logo (PHASE_16 workstream 7): a pixel read, and a
  // metered vision call when the logo is ambiguous. A seller tries a few logos.
  "brand.palette": { user: { limit: 30, windowSeconds: HOUR }, ip: { limit: 60, windowSeconds: HOUR } },
  "jobs.create": { user: { limit: 60, windowSeconds: HOUR }, ip: { limit: 120, windowSeconds: HOUR } },
  "products.create": { user: { limit: 120, windowSeconds: HOUR }, ip: { limit: 240, windowSeconds: HOUR } },
  // Each side by side image fetches two pictures and renders a new one.
  "jobs.makeover": { user: { limit: 60, windowSeconds: HOUR }, ip: { limit: 120, windowSeconds: HOUR } },
  // The all files zip streams every delivered file of a pack out of storage.
  // A seller downloads a pack a handful of times; 30 an hour leaves room.
  "jobs.pack": { user: { limit: 30, windowSeconds: HOUR }, ip: { limit: 30, windowSeconds: HOUR } },
  // Product link imports make the server fetch outside pages, so they are
  // counted per workspace (the "user" rule) as well as per IP.
  "imports.product": { user: { limit: 30, windowSeconds: HOUR }, ip: { limit: 60, windowSeconds: HOUR } },
  "imports.photo": { user: { limit: 60, windowSeconds: HOUR }, ip: { limit: 120, windowSeconds: HOUR } },
  // Anonymous email capture on the free tools: IP only, since there is no
  // user. A person leaves one email; a few retries and a shared office fit.
  "leads.create": { user: { limit: 20, windowSeconds: HOUR }, ip: { limit: 20, windowSeconds: HOUR } },
  // Publishing and unpublishing a share page.
  "shares.write": { user: { limit: 60, windowSeconds: HOUR }, ip: { limit: 120, windowSeconds: HOUR } },
  // Public share page images: each one is a storage read plus a re-encode on
  // a cache miss, so one IP cannot loop on them. A page shows a handful and
  // the gallery a few dozen, far below this.
  "shares.image": { user: { limit: 600, windowSeconds: HOUR }, ip: { limit: 600, windowSeconds: HOUR } },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitPolicyName = keyof typeof RATE_LIMIT_POLICIES;
export type RateLimitScope = keyof RateLimitPolicy;

export interface RateLimitStore {
  /** Adds one hit to the counter at key and returns the count after the hit.
   * A new counter expires after ttlMs. */
  increment(key: string, ttlMs: number, nowMs: number): Promise<number>;
}

/** Per instance counters. Bounded, so a flood of distinct subjects cannot
 * grow memory without limit. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly counters = new Map<string, { count: number; expiresAt: number }>();

  constructor(private readonly maxKeys = 50_000) {}

  async increment(key: string, ttlMs: number, nowMs: number): Promise<number> {
    const existing = this.counters.get(key);
    if (existing && existing.expiresAt > nowMs) {
      existing.count += 1;
      return existing.count;
    }
    if (existing) {
      this.counters.delete(key);
    }
    if (this.counters.size >= this.maxKeys) {
      this.prune(nowMs);
    }
    this.counters.set(key, { count: 1, expiresAt: nowMs + ttlMs });
    return 1;
  }

  get size(): number {
    return this.counters.size;
  }

  private prune(nowMs: number): void {
    for (const [key, value] of this.counters) {
      if (value.expiresAt <= nowMs) {
        this.counters.delete(key);
      }
    }
    // Still full: drop the oldest entries (Map keeps insertion order).
    const target = Math.floor(this.maxKeys * 0.9);
    for (const key of this.counters.keys()) {
      if (this.counters.size <= target) {
        break;
      }
      this.counters.delete(key);
    }
  }
}

/** The one Redis call the limiter needs. @upstash/redis Redis satisfies it. */
export interface RedisEval {
  eval<TArgs extends unknown[], TData = unknown>(script: string, keys: string[], args: TArgs): Promise<TData>;
}

// INCR and set the expiry on the first hit, atomically, in one round trip.
const INCREMENT_SCRIPT = `local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count`;

export class UpstashRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: RedisEval) {}

  async increment(key: string, ttlMs: number): Promise<number> {
    const count = await this.redis.eval<[number], number | string>(INCREMENT_SCRIPT, [key], [Math.max(1, Math.ceil(ttlMs))]);
    const value = Number(count);
    if (!Number.isFinite(value)) {
      throw new Error("Unexpected rate limit counter reply");
    }
    return value;
  }
}

/** Uses the primary store and falls back to the secondary when it throws. */
export class FallbackRateLimitStore implements RateLimitStore {
  private warned = false;

  constructor(
    private readonly primary: RateLimitStore,
    private readonly fallback: RateLimitStore,
  ) {}

  async increment(key: string, ttlMs: number, nowMs: number): Promise<number> {
    try {
      return await this.primary.increment(key, ttlMs, nowMs);
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        console.warn("[rate-limit] shared limiter unavailable, using the in process limiter", err);
      }
      return this.fallback.increment(key, ttlMs, nowMs);
    }
  }
}

const globalScope = globalThis as typeof globalThis & { __curviRateLimitStore?: RateLimitStore };

/** Upstash when both env vars are set, the in process limiter otherwise. */
export function createRateLimitStore(): RateLimitStore {
  const url = optionalEnv("UPSTASH_REDIS_REST_URL");
  const token = optionalEnv("UPSTASH_REDIS_REST_TOKEN");
  const memory = new MemoryRateLimitStore();
  if (!url || !token) {
    return memory;
  }
  const redis = new Redis({
    url,
    token,
    // A limiter must never hold a request hostage: one quick retry, a short
    // timeout, then the in process fallback answers.
    retry: { retries: 1, backoff: () => 50 },
    signal: () => AbortSignal.timeout(1500),
  });
  return new FallbackRateLimitStore(new UpstashRateLimitStore(redis), memory);
}

export function getRateLimitStore(): RateLimitStore {
  if (!globalScope.__curviRateLimitStore) {
    globalScope.__curviRateLimitStore = createRateLimitStore();
  }
  return globalScope.__curviRateLimitStore;
}

/** Test hook: swap the process wide store (null resets to the env default). */
export function setRateLimitStoreForTests(store: RateLimitStore | null): void {
  globalScope.__curviRateLimitStore = store ?? undefined;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the current window ends. */
  retryAfterSeconds: number;
}

export async function checkRateLimit(
  policy: RateLimitPolicyName,
  scope: RateLimitScope,
  subject: string,
  options: { store?: RateLimitStore; nowMs?: number } = {},
): Promise<RateLimitDecision> {
  const rule = RATE_LIMIT_POLICIES[policy][scope];
  const windowMs = rule.windowSeconds * 1000;
  const nowMs = options.nowMs ?? Date.now();
  const windowIndex = Math.floor(nowMs / windowMs);
  const resetAt = (windowIndex + 1) * windowMs;
  const key = `rl:${policy}:${scope}:${subject.slice(0, 128)}:${windowIndex}`;
  const count = await (options.store ?? getRateLimitStore()).increment(key, resetAt - nowMs, nowMs);
  return {
    allowed: count <= rule.limit,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - nowMs) / 1000)),
  };
}

/** Plain spoken wait message for a 429 (CLAUDE.md rule 9). */
export function rateLimitMessage(retryAfterSeconds: number): string {
  if (retryAfterSeconds <= 60) {
    return "You are going a bit fast. Try again in a minute.";
  }
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return `You are going a bit fast. Try again in ${minutes} minutes.`;
}

export function rateLimitedResponse(decision: RateLimitDecision): NextResponse {
  return NextResponse.json(
    {
      error: rateLimitMessage(decision.retryAfterSeconds),
      reason: "rate_limited",
      retryAfterSeconds: decision.retryAfterSeconds,
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(decision.retryAfterSeconds),
        "X-RateLimit-Limit": String(decision.limit),
        "X-RateLimit-Remaining": "0",
      },
    },
  );
}

/**
 * The client IP. A Cloudflare edge in front of the app sets cf-connecting-ip
 * and true-client-ip from the TCP peer and overwrites any value the client
 * sent, so those win. The first X-Forwarded-For entry comes next. Without such
 * an edge these headers can be forged, which is why the IP limit is only the
 * coarse outer check and the per user limit is the one that holds.
 */
export function clientIp(headers: Headers): string {
  const direct = headers.get("cf-connecting-ip") ?? headers.get("true-client-ip") ?? headers.get("x-real-ip");
  if (direct?.trim()) {
    return direct.trim().slice(0, 64);
  }
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded ? forwarded.slice(0, 64) : "unknown";
}

/**
 * Paths no limiter may ever answer with 429. Render polls /api/health every
 * few seconds and counts anything but a 2xx or 3xx as a failure: after 15
 * seconds it stops routing traffic and after 60 seconds it restarts the
 * instance. The health route calls no limiter and the middleware does not
 * match it; this list keeps it safe if either ever changes.
 */
export const RATE_LIMIT_EXEMPT_PATHS: readonly string[] = ["/api/health"];

/** True for a path on RATE_LIMIT_EXEMPT_PATHS, with or without a trailing slash. */
export function isRateLimitExempt(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return RATE_LIMIT_EXEMPT_PATHS.includes(normalized);
}

function requestPathname(request: Request): string | null {
  try {
    return new URL(request.url).pathname;
  } catch {
    return null;
  }
}

/**
 * The IP check. Returns a 429 response when over the limit, else null. With
 * no client address at all it does nothing: one shared "unknown" bucket would
 * let a single caller lock everyone out, and the per user limit still holds.
 * Exempt paths (the health check) are never counted.
 */
export async function limitByIp(
  request: Request,
  policy: RateLimitPolicyName,
  options: { store?: RateLimitStore; nowMs?: number } = {},
): Promise<NextResponse | null> {
  const pathname = requestPathname(request);
  if (pathname !== null && isRateLimitExempt(pathname)) {
    return null;
  }
  const ip = clientIp(request.headers);
  if (ip === "unknown") {
    return null;
  }
  const decision = await checkRateLimit(policy, "ip", `ip:${ip}`, options);
  return decision.allowed ? null : rateLimitedResponse(decision);
}

/** The per user check. Returns a 429 response when over the limit, else null. */
export async function limitByUser(
  policy: RateLimitPolicyName,
  subject: string,
  options: { store?: RateLimitStore; nowMs?: number } = {},
): Promise<NextResponse | null> {
  const decision = await checkRateLimit(policy, "user", subject, options);
  return decision.allowed ? null : rateLimitedResponse(decision);
}

/**
 * The subject for per user limits: the signed in Supabase user, or the
 * workspace when there is no user (demo mode has one shared workspace).
 */
export async function userRateLimitSubject(workspaceId: string): Promise<string> {
  try {
    const user = await getSessionUser();
    if (user?.id) {
      return `user:${user.id}`;
    }
  } catch {
    // Fall through to the workspace key.
  }
  return `ws:${workspaceId}`;
}
