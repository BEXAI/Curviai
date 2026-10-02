/**
 * Request rate limits for the write routes that cost storage or credits:
 * upload signing and completion, job creation and product creation (plan 4.1
 * and 4.5). Each route is limited twice, by client IP before any auth work
 * and by the signed in user after it, and answers 429 with Retry-After.
 * The MCP server's reads and its lasting links have their own policies
 * (PHASE_19 P19-21), and callers that arrive through an assistant's shared
 * addresses are counted per user and per workspace instead of per IP
 * (overLimit in lib/api-v1/actions).
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
import { freePreview, customerSupport, errorReporting } from "@curvi/pipeline/seed";
import { NextResponse } from "next/server";
import { storeAudit } from "@curvi/pipeline/seed";
import { optionalEnv } from "@/lib/env";
import { getSessionUser } from "@/lib/supabase/server";
import { clientIp, requestHostAllowed } from "@/lib/http/client-ip";
export { clientIp } from "@/lib/http/client-ip";

export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

export interface RateLimitPolicy {
  /** Per signed in user (or per workspace when no user id is available). */
  user: RateLimitRule;
  /** Per client IP, checked before authentication. */
  ip: RateLimitRule;
  /**
   * Per workspace, in place of the IP rule for callers exempt from it
   * (PHASE_19 P19-21: OAuth callers from ChatGPT, whose calls all arrive
   * from OpenAI's shared egress addresses). Defaults to the IP rule's
   * numbers: a workspace's members share it the way an office shares an
   * address.
   */
  workspace?: RateLimitRule;
}

const HOUR = 3600;
const DAY = 24 * HOUR;

/**
 * Named policies. The IP limits are looser than the user limits because a
 * team, an agency office or a mobile carrier can share one address.
 */
export const RATE_LIMIT_POLICIES = {
  "telemetry.error": { user: { limit: errorReporting.maxEventsPerHour, windowSeconds: HOUR }, ip: { limit: errorReporting.maxEventsPerHour, windowSeconds: HOUR } },
  "support.contact": { user: { limit: customerSupport.perUserPerHour, windowSeconds: HOUR }, ip: { limit: customerSupport.perIpPerHour, windowSeconds: HOUR } },
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
  // Favorites and picking scene versions (PHASE_16 workstream 6): one small
  // row write each, tapped through a gallery. Generous, but bounded.
  "assets.write": { user: { limit: 600, windowSeconds: HOUR }, ip: { limit: 1200, windowSeconds: HOUR } },
  // The first run answers on /welcome (Phase 18 P18-20): one small
  // row write, asked once.
  "workspace.profile": { user: { limit: 30, windowSeconds: HOUR }, ip: { limit: 60, windowSeconds: HOUR } },
  // The free white main image before signup (Phase 18 P18-12, decision 6):
  // previews per client IP per UTC day, from the seed (the window is a UTC
  // day because windows start at the epoch). IP only; there is no user.
  "preview.create": {
    user: { limit: freePreview.perIpPerDay, windowSeconds: DAY },
    ip: { limit: freePreview.perIpPerDay, windowSeconds: DAY },
  },
  // Publishing and unpublishing a share page.
  "shares.write": { user: { limit: 60, windowSeconds: HOUR }, ip: { limit: 120, windowSeconds: HOUR } },
  // Public share page images: each one is a storage read plus a re-encode on
  // a cache miss, so one IP cannot loop on them. A page shows a handful and
  // the gallery a few dozen, far below this.
  "shares.image": { user: { limit: 600, windowSeconds: HOUR }, ip: { limit: 600, windowSeconds: HOUR } },
  // MCP reads (PHASE_19 P19-21): get_pack, list_channels and get_profile. An
  // assistant polls get_pack while a pack runs (the pack viewer every 5
  // seconds, 720 an hour), so one user can follow a pack and a half at once.
  "mcp.read": { user: { limit: 1200, windowSeconds: HOUR }, ip: { limit: 2400, windowSeconds: HOUR } },
  // The lasting preview and download links an assistant shares (P19-17): per
  // IP, and per connection or API key (the "user" rule, subject conn:<id> or
  // key:<id>), never per workspace, so a link copied out of one chat cannot
  // use up the links of the workspace's other connections.
  "mcp.links": { user: { limit: 600, windowSeconds: HOUR }, ip: { limit: 600, windowSeconds: HOUR } },
  // The cookieless visitor count's beacon (/api/visits), IP only since there
  // is no sign in (the user rules are unused). visits.record: every page view
  // from one address; a person opens a few pages a minute at most and a
  // shared office still fits. visits.newVisitor: the new visitor codes one
  // address can make, so a script that sends a new user agent on every
  // request adds at most 30 visitors an hour instead of one per request.
  // Over either limit the page view is not counted; the beacon still gets 204.
  "visits.record": { user: { limit: 300, windowSeconds: HOUR }, ip: { limit: 300, windowSeconds: HOUR } },
  "visits.newVisitor": { user: { limit: 30, windowSeconds: HOUR }, ip: { limit: 30, windowSeconds: HOUR } },
  // The store image audit (P18-18), anonymous, so IP only (the user rule is
  // unused). Each audit makes the server fetch a store's product list and
  // up to storeAudit.maxProducts images, so the number is seeded
  // (growth.ts). The site wide daily cap is its own counter in
  // lib/store-audit/daily-cap.ts.
  "tools.storeAudit": {
    user: { limit: storeAudit.auditsPerIpPerHour, windowSeconds: HOUR },
    ip: { limit: storeAudit.auditsPerIpPerHour, windowSeconds: HOUR },
  },
  // Pack feedback (P18-05): one small row per pack and person, from the
  // pack page or a signed email link. A person answers a few packs a day.
  "feedback.write": { user: { limit: 30, windowSeconds: HOUR }, ip: { limit: 60, windowSeconds: HOUR } },
  // The operator's prospect tool (P18-04): adding credits and making claim
  // links. Operators only, so generous; a pack itself goes through jobs.create.
  "ops.prospects": { user: { limit: 120, windowSeconds: HOUR }, ip: { limit: 240, windowSeconds: HOUR } },
  // Taking a prospect page down from its claim link (P18-04), anonymous, so
  // IP only. A person takes a page down once; a few retries fit.
  "claims.takedown": { user: { limit: 10, windowSeconds: HOUR }, ip: { limit: 10, windowSeconds: HOUR } },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitPolicyName = keyof typeof RATE_LIMIT_POLICIES;
export type RateLimitScope = keyof RateLimitPolicy;

/** The rule a policy applies to a scope; the workspace rule falls back to the
 * IP rule's numbers. */
export function rateLimitRule(policy: RateLimitPolicyName, scope: RateLimitScope): RateLimitRule {
  const entry: RateLimitPolicy = RATE_LIMIT_POLICIES[policy];
  return scope === "workspace" ? (entry.workspace ?? entry.ip) : entry[scope];
}

/**
 * The policy an MCP tool call meets before its action runs (PHASE_19
 * P19-21), by tool name. create_pack and check_main_image are absent: their
 * actions count jobs.create, imports.photo and uploads.preflight themselves.
 * estimate_pack reads the photos it is given, so it counts against
 * imports.photo per user, as a photo link import does.
 */
export const MCP_TOOL_RATE_POLICIES: Readonly<Record<string, RateLimitPolicyName>> = {
  get_pack: "mcp.read",
  list_channels: "mcp.read",
  get_profile: "mcp.read",
  estimate_pack: "imports.photo",
};

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
  const rule = rateLimitRule(policy, scope);
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
  if (!requestHostAllowed(request)) {
    return NextResponse.json({ error: "Use the configured Curvi address." }, { status: 403 });
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
