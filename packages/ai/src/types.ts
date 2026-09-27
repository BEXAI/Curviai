/**
 * Public contract of the AI abstraction layer. Every external provider call in
 * Curvi goes through this package (CLAUDE.md rule 4): timeout, retry, failover,
 * circuit breaker and cost metering live here and nowhere else.
 *
 * Other packages import these types. Do not make breaking changes to the
 * exported shapes without updating dependents in the same commit.
 */

export type ProviderKind = "llm" | "image" | "video" | "cutout" | "upscale" | "avatar";

/** Task names are stable routing keys, e.g. "analyze_product", "scene_plate",
 * "harmonize", "generate_image", "video_i2v", "remove_background". */
export interface ProviderRequest<TIn = unknown> {
  task: string;
  input: TIn;
  /** Overrides the provider default. */
  timeoutMs?: number;
  /** Threaded through to the cost meter for attribution. */
  workspaceId?: string;
  jobId?: string;
  stepId?: string;
  idempotencyKey?: string;
}

export interface ProviderResponse<TOut = unknown> {
  output: TOut;
  /** Actual or estimated cost of this single call in USD micros. */
  costMicros: number;
}

export interface Provider {
  /** Registry key, e.g. "nano-banana-2", "flux2-pro", "claude-sonnet-5", "mock-image". */
  name: string;
  kind: ProviderKind;
  supports(task: string): boolean;
  invoke<TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>>;
}

export interface CallResult<TOut = unknown> extends ProviderResponse<TOut> {
  provider: string;
  /** Total attempts across all providers tried, including the successful one. */
  attempts: number;
  latencyMs: number;
}

export interface CostMeterEntry {
  provider: string;
  task: string;
  costMicros: number;
  latencyMs: number;
  ok: boolean;
  error?: string;
  workspaceId?: string;
  jobId?: string;
  stepId?: string;
  attempt: number;
  at: Date;
}

export interface CostMeter {
  record(entry: CostMeterEntry): void | Promise<void>;
}

/** Pluggable state store for circuit breakers. Upstash Redis in production,
 * in memory in tests and local dev. */
export interface BreakerStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  incr(key: string, ttlSeconds: number): Promise<number>;
}

export interface BreakerOptions {
  /** Failures within windowSeconds that open the breaker. Default 5. */
  failureThreshold: number;
  /** Rolling failure window. Default 60. */
  windowSeconds: number;
  /** How long the breaker stays open. Default 120. */
  openSeconds: number;
}

export interface RetryOptions {
  /** Retries per provider before failing over. Default 2. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RouteOptions {
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
  breaker?: Partial<BreakerOptions>;
  /**
   * Reject the call before invoking when the provider's estimated cost would
   * exceed this. The guard fails closed: a provider that does not implement
   * estimateCostMicros is rejected with a non retryable ProviderError rather
   * than silently invoked uncapped, unless allowUnestimatedCost is true.
   */
  maxCostMicros?: number;
  /**
   * Explicit opt out of the fail closed behavior above: lets a call with
   * maxCostMicros or a caps hook proceed on a provider that cannot estimate
   * its cost. Defaults to false (fail closed).
   */
  allowUnestimatedCost?: boolean;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly task: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class AllProvidersFailedError extends Error {
  constructor(
    readonly task: string,
    readonly errors: ProviderError[],
  ) {
    super(`All providers failed for task ${task}: ${errors.map((e) => `${e.provider}: ${e.message}`).join("; ")}`);
    this.name = "AllProvidersFailedError";
  }
}

export class BreakerOpenError extends ProviderError {
  constructor(provider: string, task: string) {
    super(`Circuit breaker open for ${provider}`, provider, task, false);
    this.name = "BreakerOpenError";
  }
}
