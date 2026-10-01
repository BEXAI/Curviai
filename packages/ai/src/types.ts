/**
 * Public contract of the AI abstraction layer. Every external provider call in
 * Curvi goes through this package (CLAUDE.md rule 4): timeout, retry, failover,
 * circuit breaker and cost metering live here and nowhere else.
 *
 * Other packages import these types. Do not make breaking changes to the
 * exported shapes without updating dependents in the same commit.
 */

import type { LlmUsage } from "./llm";

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
  /**
   * Spend the failed attempts of this call were billed anyway, in USD micros:
   * for example a paid async create on a provider that then stalled, before
   * the chain failed over to the one that delivered. costMicros is only the
   * delivering attempt, so a caller that books job or shot cost adds this to
   * match what the meter recorded and the spend caps hold. Zero when no
   * failed attempt was billed.
   */
  billedFailureMicros: number;
}

export interface CostMeterEntry {
  provider: string;
  task: string;
  /** Spend of this attempt in USD micros. A failed attempt carries the
   * amount the provider billed anyway (ProviderError.billedCostMicros),
   * zero when nothing was billed. */
  costMicros: number;
  latencyMs: number;
  ok: boolean;
  error?: string;
  /** Machine readable failure class, when the adapter or router set one. */
  errorCode?: ProviderErrorCode;
  workspaceId?: string;
  jobId?: string;
  stepId?: string;
  attempt: number;
  at: Date;
  /**
   * Token usage of an LLM attempt (docs/phases/PHASE_17.md workstream 6):
   * uncached and cached input apart, output, and the reasoning tokens
   * inside the output. Set on a success that returned an LlmResult and on a
   * billed failure whose adapter reported its usage (a truncated or refused
   * reply). Absent for image, cutout and other non LLM calls.
   */
  usage?: LlmUsage;
  /** The first provider of the chain this call walked, so a monitor can
   * tell a call its primary served from one a fallback served. */
  primaryProvider?: string;
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

/**
 * Machine readable failure classes. Callers branch on these instead of
 * matching message text.
 * - content_blocked: the provider's safety system declined the prompt or
 *   the output. Never retried on the same provider and never counted
 *   toward the shared circuit breaker, since it says nothing about the
 *   provider's health.
 * - empty_output: the provider answered without usable output (no image,
 *   no text or tool block). Not retried on the same provider.
 * - output_truncated: an LLM reply stopped at its max_tokens budget before
 *   the answer was complete (thinking counts toward that budget). Billed,
 *   not retried on the same provider, not transient.
 * - timeout: the router's per attempt timeout elapsed.
 * - estimate_failed: the provider could not estimate its cost, so a cost
 *   capped call refused it before invoking.
 * - cap_blocked: a spend cap refused the reservation.
 * - cap_unavailable: the spend cap reservation could not be made (store
 *   error or missing identifiers); the call fails closed.
 * - provider_quota: the provider refused because the account ran out of
 *   quota, credit or plan images (HTTP 402, Photoroom style "exhausted the
 *   number of images", BFL "Insufficient credits", OpenAI insufficient_quota
 *   or an OpenAI billing error.code such as credit_balance_exhausted,
 *   Gemini RESOURCE_EXHAUSTED on a billing or daily quota). Never retried on
 *   the same provider: the router opens that provider's breaker at once for
 *   a long cooldown and fails over. It is not transient: waiting a few
 *   seconds never fixes an empty account.
 */
export type ProviderErrorCode =
  | "content_blocked"
  | "provider_quota"
  | "empty_output"
  | "output_truncated"
  | "timeout"
  | "estimate_failed"
  | "cap_blocked"
  | "cap_unavailable";

export interface ProviderErrorDetails {
  code?: ProviderErrorCode;
  /**
   * Provider spend this failed attempt still incurred, in USD micros: for
   * example an async job that was created (and paid for) before polling
   * failed, or LLM usage billed on a refusal. The router meters it and keeps
   * it against the spend caps instead of releasing it.
   */
  billedCostMicros?: number;
  /**
   * Whether the failure says the provider itself is unhealthy (5xx, 429,
   * timeout, network, a stalled job). Only transient failures count toward
   * the shared circuit breaker. Defaults to retryable. A failure can be
   * transient yet not retryable, for example a timeout after a paid job
   * create: retrying would pay again, but the breaker should still learn
   * the provider is struggling so later calls stop paying for it.
   */
  transient?: boolean;
  /**
   * How long the provider asked the caller to wait before trying again, in
   * milliseconds, read from a Retry-After (or retry-after-ms) header on a
   * 429 or 5xx answer. The router waits at least this long before the next
   * attempt on the same provider, never longer than its backoff cap.
   */
  retryAfterMs?: number;
  /**
   * Token usage the failed LLM attempt was billed for, when the adapter
   * read it from the reply (a refusal, a truncated or an empty answer). The
   * router puts it on the meter entry, so reasoning tokens spent on a
   * truncated reply are still logged.
   */
  usage?: LlmUsage;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode | undefined;
  /** See ProviderErrorDetails.billedCostMicros. Zero when nothing was billed. */
  readonly billedCostMicros: number;
  /** See ProviderErrorDetails.transient. Never true for content_blocked. */
  readonly transient: boolean;
  /** See ProviderErrorDetails.retryAfterMs. Undefined when the provider sent none. */
  readonly retryAfterMs: number | undefined;
  /** See ProviderErrorDetails.usage. Undefined when the adapter read none. */
  readonly usage: LlmUsage | undefined;

  constructor(
    message: string,
    readonly provider: string,
    readonly task: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
    details: ProviderErrorDetails = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.code = details.code;
    this.transient =
      details.code === "content_blocked" || details.code === "provider_quota" ? false : (details.transient ?? retryable);
    const billed = details.billedCostMicros ?? 0;
    this.billedCostMicros = Number.isFinite(billed) && billed > 0 ? Math.ceil(billed) : 0;
    const wait = details.retryAfterMs;
    this.retryAfterMs = wait !== undefined && Number.isFinite(wait) && wait >= 0 ? Math.ceil(wait) : undefined;
    this.usage = details.usage;
  }
}

export class AllProvidersFailedError extends Error {
  /**
   * Spend every failed attempt in the chain was billed anyway, in USD micros,
   * as the router metered it and kept it against the spend caps. errors holds
   * only each provider's last error, so the router passes the running total;
   * without it the total is summed from errors.
   */
  readonly billedCostMicros: number;

  constructor(
    readonly task: string,
    readonly errors: ProviderError[],
    billedCostMicros?: number,
  ) {
    super(`All providers failed for task ${task}: ${errors.map((e) => `${e.provider}: ${e.message}`).join("; ")}`);
    this.name = "AllProvidersFailedError";
    const summed = errors.reduce((sum, e) => sum + e.billedCostMicros, 0);
    this.billedCostMicros =
      billedCostMicros !== undefined && Number.isFinite(billedCostMicros) && billedCostMicros > summed
        ? Math.ceil(billedCostMicros)
        : summed;
  }
}

export class BreakerOpenError extends ProviderError {
  /**
   * Why the breaker is open: "quota" when a provider_quota answer tripped it
   * (the error then carries the provider_quota code too), "failures" when
   * transient failures opened it.
   */
  readonly reason: "quota" | "failures";

  constructor(provider: string, task: string, reason: "quota" | "failures" = "failures") {
    super(
      reason === "quota"
        ? `Circuit breaker open for ${provider}: the provider account is out of quota`
        : `Circuit breaker open for ${provider}`,
      provider,
      task,
      false,
      undefined,
      reason === "quota" ? { code: "provider_quota" } : {},
    );
    this.name = "BreakerOpenError";
    this.reason = reason;
  }
}

/**
 * The spend cap reservation could not be made: the cap store threw (for
 * example a database error) or the caps hook lacks an identifier. The router
 * releases the layers it already held and refuses the provider, so the call
 * fails closed and never runs uncapped. The message keeps the "Spend cap
 * blocked" prefix so callers that route cap blocks to needs review treat it
 * the same way.
 */
export class CapStoreUnavailableError extends ProviderError {
  constructor(provider: string, task: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Spend cap blocked call: the spend cap reservation could not be made (${detail})`,
      provider,
      task,
      false,
      cause,
      { code: "cap_unavailable" },
    );
    this.name = "CapStoreUnavailableError";
  }
}

/** Every ProviderError inside err: itself, or the chain an
 * AllProvidersFailedError carries. */
export function providerErrorsOf(err: unknown): ProviderError[] {
  if (err instanceof AllProvidersFailedError) return err.errors;
  if (err instanceof ProviderError) return [err];
  return [];
}

/**
 * True when a failed call says its provider chain is unavailable right now,
 * not that this request is wrong: every provider in the chain failed with a
 * transient error (timeout, 5xx, 429, network, a stalled job), sat behind an
 * open circuit breaker, or ran out of quota. A content block, a cap block, a
 * non transient 4xx or an unsupported task anywhere in the chain means no.
 */
export function isProviderChainUnavailable(err: unknown): boolean {
  const errors = providerErrorsOf(err);
  if (errors.length === 0) return false;
  return errors.every(
    (e) => e.code === "provider_quota" || e instanceof BreakerOpenError || (e.transient && e.code !== "content_blocked"),
  );
}

/**
 * True when a failed call is worth one delayed retry: the chain is
 * unavailable (above) and at least one provider failed transiently (a
 * timeout, 429, 5xx or network error), so a short wait may fix it. A chain
 * that failed only on quota or open breakers is not retried: the breaker
 * cooldown outlasts any short backoff.
 */
export function isTransientChainFailure(err: unknown): boolean {
  if (!isProviderChainUnavailable(err)) return false;
  return providerErrorsOf(err).some(
    (e) => e.transient && e.code !== "provider_quota" && !(e instanceof BreakerOpenError),
  );
}

/** True when err, or any provider error in a failed chain, carries code.
 * For example hasProviderErrorCode(err, "content_blocked") tells a caller to
 * show "the image service declined this scene" instead of a generic failure. */
export function hasProviderErrorCode(err: unknown, code: ProviderErrorCode): boolean {
  return providerErrorsOf(err).some((e) => e.code === code);
}

/**
 * Provider spend a failed call was billed anyway, in USD micros: the chain
 * total of an AllProvidersFailedError, a single ProviderError's
 * billedCostMicros, zero for anything else. Callers add it to the job or shot
 * cost so COGS matches what the meter recorded and the spend caps hold.
 */
export function billedMicrosOf(err: unknown): number {
  if (err instanceof AllProvidersFailedError) return err.billedCostMicros;
  if (err instanceof ProviderError) return err.billedCostMicros;
  return 0;
}
