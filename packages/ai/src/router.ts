/**
 * callWithFailover: the single entry point for every provider call in Curvi
 * (CLAUDE.md rule 4). Walks the ordered failover chain for the request's
 * task and, per provider: skips it when the circuit breaker is open,
 * enforces a timeout with AbortController plus Promise.race, retries with
 * exponential backoff and jitter, meters every attempt (ok and failed),
 * records breaker failures and successes, and rejects on estimated cost
 * above opts.maxCostMicros before invoking. When the whole chain fails it
 * throws AllProvidersFailedError carrying every ProviderError.
 */

import { CircuitBreaker } from "./breaker";
import type { ProviderRegistry, RoutingTable } from "./registry";
import {
  AllProvidersFailedError,
  BreakerOpenError,
  ProviderError,
  type BreakerStore,
  type CallResult,
  type CostMeter,
  type Provider,
  type ProviderRequest,
  type RetryOptions,
  type RouteOptions,
} from "./types";

export const DEFAULT_TIMEOUT_MS = 60_000;

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  retries: 2,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
};

/** The request shape the router hands to providers: the caller's request
 * plus an AbortSignal that fires when the router's timeout elapses.
 * Adapters should pass it to fetch. Additive, does not break ProviderRequest. */
export interface RoutedProviderRequest<TIn = unknown> extends ProviderRequest<TIn> {
  signal?: AbortSignal;
}

/** Providers may report an estimated cost so the router can reject a call
 * before invoking when opts.maxCostMicros would be exceeded. Additive
 * extension, does not break Provider. */
export interface CostAwareProvider extends Provider {
  estimateCostMicros?(req: ProviderRequest): number | Promise<number>;
}

export class ProviderTimeoutError extends ProviderError {
  constructor(provider: string, task: string, timeoutMs: number) {
    super(`Provider ${provider} timed out after ${timeoutMs}ms`, provider, task, true);
    this.name = "ProviderTimeoutError";
  }
}

/** RouteOptions plus injectable effects for tests. */
export interface CallWithFailoverOptions extends RouteOptions {
  /** Injectable sleep for backoff, defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source in [0, 1), defaults to Math.random. */
  random?: () => number;
  /** Injectable millisecond clock, defaults to Date.now. */
  now?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toProviderError(err: unknown, provider: string, task: string): ProviderError {
  if (err instanceof ProviderError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // Unknown failures are treated as transient and retryable.
  return new ProviderError(message, provider, task, true, err);
}

/** Exponential backoff with half to full jitter. */
export function backoffDelayMs(attemptIndex: number, retry: RetryOptions, random: () => number): number {
  const raw = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attemptIndex);
  return Math.round(raw * (0.5 + random() * 0.5));
}

async function invokeWithTimeout<TIn, TOut>(
  provider: Provider,
  req: ProviderRequest<TIn>,
  timeoutMs: number,
): Promise<{ output: TOut; costMicros: number }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new ProviderTimeoutError(provider.name, req.task, timeoutMs));
      reject(new ProviderTimeoutError(provider.name, req.task, timeoutMs));
    }, timeoutMs);
  });
  const routed: RoutedProviderRequest<TIn> = { ...req, signal: controller.signal };
  const invocation = provider.invoke<TIn, TOut>(routed);
  // A provider that loses the race may still reject later; mark it handled
  // so it never surfaces as an unhandled rejection.
  invocation.catch(() => {});
  try {
    return await Promise.race([invocation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function callWithFailover<TIn = unknown, TOut = unknown>(
  registry: ProviderRegistry,
  routing: RoutingTable,
  meter: CostMeter,
  breakerStore: BreakerStore,
  req: ProviderRequest<TIn>,
  opts: CallWithFailoverOptions = {},
): Promise<CallResult<TOut>> {
  const chain = routing[req.task];
  if (!chain || chain.length === 0) {
    throw new Error(`No providers routed for task "${req.task}"`);
  }

  const retry: RetryOptions = { ...DEFAULT_RETRY_OPTIONS, ...opts.retry };
  const breaker = new CircuitBreaker(breakerStore, opts.breaker);
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;
  const timeoutMs = req.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const startedAt = now();
  const errors: ProviderError[] = [];
  let attempts = 0;

  for (const providerName of chain) {
    const provider = registry.get(providerName) as CostAwareProvider | undefined;
    if (!provider) {
      errors.push(new ProviderError(`Provider "${providerName}" is not registered`, providerName, req.task, false));
      continue;
    }
    if (!provider.supports(req.task)) {
      errors.push(
        new ProviderError(`Provider "${providerName}" does not support task "${req.task}"`, providerName, req.task, false),
      );
      continue;
    }
    if (await breaker.isOpen(providerName)) {
      errors.push(new BreakerOpenError(providerName, req.task));
      continue;
    }
    if (opts.maxCostMicros !== undefined && typeof provider.estimateCostMicros === "function") {
      const estimate = await provider.estimateCostMicros(req);
      if (estimate > opts.maxCostMicros) {
        errors.push(
          new ProviderError(
            `Estimated cost ${estimate} micros exceeds maxCostMicros ${opts.maxCostMicros}`,
            providerName,
            req.task,
            false,
          ),
        );
        continue;
      }
    }

    let movedOn = false;
    for (let attemptIndex = 0; attemptIndex <= retry.retries && !movedOn; attemptIndex++) {
      attempts += 1;
      const attemptStart = now();
      try {
        const res = await invokeWithTimeout<TIn, TOut>(provider, req, timeoutMs);
        const latencyMs = now() - attemptStart;
        await meter.record({
          provider: providerName,
          task: req.task,
          costMicros: res.costMicros,
          latencyMs,
          ok: true,
          workspaceId: req.workspaceId,
          jobId: req.jobId,
          stepId: req.stepId,
          attempt: attempts,
          at: new Date(),
        });
        await breaker.recordSuccess(providerName);
        return {
          output: res.output,
          costMicros: res.costMicros,
          provider: providerName,
          attempts,
          latencyMs: now() - startedAt,
        };
      } catch (err) {
        const providerError = toProviderError(err, providerName, req.task);
        const latencyMs = now() - attemptStart;
        await meter.record({
          provider: providerName,
          task: req.task,
          costMicros: 0,
          latencyMs,
          ok: false,
          error: providerError.message,
          workspaceId: req.workspaceId,
          jobId: req.jobId,
          stepId: req.stepId,
          attempt: attempts,
          at: new Date(),
        });
        await breaker.recordFailure(providerName);
        if (!providerError.retryable || attemptIndex === retry.retries) {
          errors.push(providerError);
          movedOn = true;
        } else {
          await sleep(backoffDelayMs(attemptIndex, retry, random));
        }
      }
    }
  }

  throw new AllProvidersFailedError(req.task, errors);
}
