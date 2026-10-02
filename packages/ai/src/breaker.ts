/**
 * Circuit breaker over the pluggable BreakerStore (Upstash Redis in
 * production, InMemoryBreakerStore in tests and local dev).
 *
 * Semantics from CURVI_BUILD_PLAN.md section 4.4: the breaker opens after
 * failureThreshold (default 5) failures within windowSeconds (default 60),
 * stays open for openSeconds (default 120), then fully closes when the open
 * key expires. There is no half open probe state yet; that is a noted follow
 * up. The failure window is TTL based: the window starts at the first failure
 * after a quiet period, which is the standard Redis INCR plus EXPIRE pattern.
 */

import type { BreakerOptions, BreakerStore } from "./types";

export const DEFAULT_BREAKER_OPTIONS: BreakerOptions = {
  failureThreshold: 5,
  windowSeconds: 60,
  openSeconds: 120,
};

/**
 * How long a provider_quota answer keeps a provider's breaker open. An empty
 * account is not fixed by waiting seconds (someone has to top it up), so the
 * cooldown is long: packs fail over or degrade instead of asking the
 * exhausted provider again on every shot. A deploy or restart clears it.
 */
export const QUOTA_OPEN_SECONDS = 30 * 60;

/** Value the open key holds when a quota answer tripped the breaker. */
export const BREAKER_OPEN_QUOTA = "quota";
const BREAKER_OPEN_FAILURES = "open";

function failuresKey(provider: string): string {
  return `breaker:${provider}:failures`;
}

function openKey(provider: string): string {
  return `breaker:${provider}:open`;
}

export class CircuitBreaker {
  private readonly options: BreakerOptions;

  constructor(
    private readonly store: BreakerStore,
    options?: Partial<BreakerOptions>,
  ) {
    this.options = { ...DEFAULT_BREAKER_OPTIONS, ...options };
  }

  /** True while the provider's open key has not expired. */
  async isOpen(provider: string): Promise<boolean> {
    return (await this.store.get(openKey(provider))) !== null;
  }

  /** Why the breaker is open ("quota" or "failures"), or null when closed. */
  async openReason(provider: string): Promise<"quota" | "failures" | null> {
    const value = await this.store.get(openKey(provider));
    if (value === null) return null;
    return value === BREAKER_OPEN_QUOTA ? "quota" : "failures";
  }

  /**
   * Opens the breaker at once, whatever the failure count: used when the
   * provider says its account is out of quota (provider_quota), which no
   * retry can fix. Defaults to QUOTA_OPEN_SECONDS.
   */
  async tripForQuota(provider: string, openSeconds: number = QUOTA_OPEN_SECONDS): Promise<void> {
    await this.store.set(openKey(provider), BREAKER_OPEN_QUOTA, openSeconds);
  }

  /**
   * Records one failure. When the count within the window reaches the
   * threshold the breaker opens for openSeconds.
   */
  async recordFailure(provider: string): Promise<void> {
    const count = await this.store.incr(failuresKey(provider), this.options.windowSeconds);
    if (count >= this.options.failureThreshold) {
      // A quota trip keeps its longer cooldown and its reason.
      if ((await this.store.get(openKey(provider))) === BREAKER_OPEN_QUOTA) return;
      await this.store.set(openKey(provider), BREAKER_OPEN_FAILURES, this.options.openSeconds);
    }
  }

  /** Resets the failure count after a successful call. */
  async recordSuccess(provider: string): Promise<void> {
    await this.store.set(failuresKey(provider), "0", this.options.windowSeconds);
  }

  /** Explicit successful canary/operator recovery, never ordinary traffic. */
  async reset(provider: string): Promise<void> {
    await this.store.set(openKey(provider), "", 0);
    await this.store.set(failuresKey(provider), "0", this.options.windowSeconds);
  }
}

interface StoredEntry {
  value: string;
  expiresAtMs: number;
}

/**
 * In memory BreakerStore with an injectable millisecond clock for tests.
 * incr creates the key with the given TTL when absent or expired and
 * preserves the existing expiry otherwise, matching Redis INCR plus
 * EXPIRE NX behavior.
 */
export class InMemoryBreakerStore implements BreakerStore {
  private readonly entries = new Map<string, StoredEntry>();

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  private live(key: string): StoredEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= this.nowMs()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAtMs: this.nowMs() + ttlSeconds * 1000 });
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const entry = this.live(key);
    if (!entry) {
      this.entries.set(key, { value: "1", expiresAtMs: this.nowMs() + ttlSeconds * 1000 });
      return 1;
    }
    const next = (Number.parseInt(entry.value, 10) || 0) + 1;
    entry.value = String(next);
    return next;
  }
}

const breakerScope = globalThis as typeof globalThis & { __curviBreakerStore?: BreakerStore };

/**
 * The breaker store every pack run in this process shares, so a provider
 * that failed or ran out of quota in one pack is skipped by the next one,
 * and the web app's health endpoint and new pack preflight read the same
 * state the runner writes. In memory: each process (the web service's inline
 * runner, a Trigger.dev worker) keeps its own.
 */
export function processBreakerStore(): BreakerStore {
  breakerScope.__curviBreakerStore ??= new InMemoryBreakerStore();
  return breakerScope.__curviBreakerStore;
}
