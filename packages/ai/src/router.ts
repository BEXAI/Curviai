/**
 * callWithFailover: the single entry point for every provider call in Curvi
 * (CLAUDE.md rule 4). Walks the ordered failover chain for the request's
 * task and, per provider: skips it when the circuit breaker is open,
 * enforces a timeout with AbortController plus Promise.race, retries with
 * exponential backoff and jitter, meters every attempt (ok and failed),
 * and records breaker successes always but breaker failures only for
 * retryable, transient errors (5xx, 429, timeout, network); a caller's non
 * retryable 4xx must never open the shared breaker for everyone.
 *
 * Cost controls, enforced before each invoke:
 * - opts.maxCostMicros rejects a provider whose estimated cost exceeds the
 *   ceiling. The guard fails closed: a provider without estimateCostMicros
 *   is rejected with a hard non retryable ProviderError instead of silently
 *   proceeding uncapped, unless opts.allowUnestimatedCost is explicitly true.
 * - opts.caps wires the call into the SpendCaps module: the provider's
 *   estimated cost is reserved with the matching checkAndReserve before
 *   invoke, reconciled to the actual cost on success, and released in full
 *   when the provider ultimately fails. A blocked reservation is a non
 *   retryable ProviderError for that provider.
 *
 * When the whole chain fails it throws AllProvidersFailedError carrying
 * every ProviderError.
 */

import { CircuitBreaker } from "./breaker";
import type { CapReservation, SpendCaps } from "./caps";
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
 * before invoking when opts.maxCostMicros would be exceeded, and so the
 * caps hook knows how much to reserve. Additive extension, does not break
 * Provider. Every adapter in src/adapters implements this. */
export interface CostAwareProvider extends Provider {
  estimateCostMicros?(req: ProviderRequest): number | Promise<number>;
}

/** Which SpendCaps counter a routed call reserves against. */
export type CapKind = "image_asset" | "video_asset" | "pack" | "workspace_day" | "global_day";

/**
 * Wires a routed call into the SpendCaps module. When present on
 * CallWithFailoverOptions the router runs the matching checkAndReserve with
 * the provider's estimated cost before invoking, reconciles the reservation
 * to the actual metered cost after success (adding the shortfall when the
 * call cost more than estimated) and releases the reservation in full when
 * the provider fails. Identifier fields fall back to the request's own
 * stepId, jobId and workspaceId.
 */
export interface CapsHook {
  spendCaps: SpendCaps;
  capKind: CapKind;
  /** For "workspace_day"; falls back to req.workspaceId. */
  workspaceId?: string;
  /** For "workspace_day": the plan's expected daily spend in USD micros. Required for that kind. */
  planExpectedDailyMicros?: number;
  /** For "image_asset" and "video_asset"; falls back to req.stepId. */
  assetId?: string;
  /** For "pack"; falls back to req.jobId. */
  jobId?: string;
}

export class ProviderTimeoutError extends ProviderError {
  constructor(provider: string, task: string, timeoutMs: number) {
    super(`Provider ${provider} timed out after ${timeoutMs}ms`, provider, task, true);
    this.name = "ProviderTimeoutError";
  }
}

/** RouteOptions plus the caps hooks and injectable effects for tests. */
export interface CallWithFailoverOptions extends RouteOptions {
  /** Reserve against SpendCaps before invoke; see CapsHook. An array layers
   * several caps (for example pack plus global day): every layer must allow
   * the call, and a blocked layer releases the ones already reserved. */
  caps?: CapsHook | CapsHook[];
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

/** Dispatches the caps hook to the matching SpendCaps checkAndReserve. */
function reserveForCaps(caps: CapsHook, req: ProviderRequest, costMicros: number): Promise<CapReservation> {
  switch (caps.capKind) {
    case "image_asset": {
      const assetId = caps.assetId ?? req.stepId;
      if (!assetId) throw new Error('caps.capKind "image_asset" needs caps.assetId or req.stepId');
      return caps.spendCaps.checkAndReserveImageAsset(assetId, costMicros);
    }
    case "video_asset": {
      const assetId = caps.assetId ?? req.stepId;
      if (!assetId) throw new Error('caps.capKind "video_asset" needs caps.assetId or req.stepId');
      return caps.spendCaps.checkAndReserveVideoAsset(assetId, costMicros);
    }
    case "pack": {
      const jobId = caps.jobId ?? req.jobId;
      if (!jobId) throw new Error('caps.capKind "pack" needs caps.jobId or req.jobId');
      return caps.spendCaps.checkAndReservePack(jobId, costMicros);
    }
    case "workspace_day": {
      const workspaceId = caps.workspaceId ?? req.workspaceId;
      if (!workspaceId) throw new Error('caps.capKind "workspace_day" needs caps.workspaceId or req.workspaceId');
      if (caps.planExpectedDailyMicros === undefined) {
        throw new Error('caps.capKind "workspace_day" needs caps.planExpectedDailyMicros');
      }
      return caps.spendCaps.checkAndReserveWorkspaceDay(workspaceId, caps.planExpectedDailyMicros, costMicros);
    }
    case "global_day":
      return caps.spendCaps.checkAndReserveGlobalDay(costMicros);
  }
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
  const capsHooks: CapsHook[] = opts.caps ? (Array.isArray(opts.caps) ? opts.caps : [opts.caps]) : [];
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

    // Cost controls. An estimate is required whenever a cost ceiling or a
    // caps reservation is in play; a provider that cannot estimate fails
    // closed with a hard ProviderError, never a silent uncapped pass.
    const needsEstimate = opts.maxCostMicros !== undefined || capsHooks.length > 0;
    let estimateMicros: number | undefined;
    if (needsEstimate) {
      if (typeof provider.estimateCostMicros === "function") {
        estimateMicros = await provider.estimateCostMicros(req);
      } else if (opts.allowUnestimatedCost !== true) {
        errors.push(
          new ProviderError(
            `Provider "${providerName}" does not implement estimateCostMicros; refusing cost capped call (set allowUnestimatedCost: true to bypass)`,
            providerName,
            req.task,
            false,
          ),
        );
        continue;
      }
    }
    if (opts.maxCostMicros !== undefined && estimateMicros !== undefined && estimateMicros > opts.maxCostMicros) {
      errors.push(
        new ProviderError(
          `Estimated cost ${estimateMicros} micros exceeds maxCostMicros ${opts.maxCostMicros}`,
          providerName,
          req.task,
          false,
        ),
      );
      continue;
    }

    // Reserve the estimated spend against every cap layer before invoking.
    // Reconciled to the actual cost on success, released in full when this
    // provider fails; a blocked layer releases the layers already reserved.
    const reservations: Array<{ hook: CapsHook; reservation: CapReservation }> = [];
    let capBlocked = false;
    for (const hook of capsHooks) {
      const reservation = await reserveForCaps(hook, req, estimateMicros ?? 0);
      if (!reservation.allowed) {
        for (const held of reservations) {
          if (held.reservation.reservedMicros !== 0) {
            await held.hook.spendCaps.release(held.reservation.key, held.reservation.reservedMicros);
          }
        }
        errors.push(
          new ProviderError(
            `Spend cap blocked call: ${reservation.reason ?? `over cap of ${reservation.capMicros} micros`}`,
            providerName,
            req.task,
            false,
          ),
        );
        capBlocked = true;
        break;
      }
      reservations.push({ hook, reservation });
    }
    if (capBlocked) {
      continue;
    }

    let succeeded = false;
    try {
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
          for (const held of reservations) {
            // Reconcile each reservation with the actual cost: release the
            // over reserved difference, or charge the shortfall when the
            // call cost more than estimated (release of a negative amount
            // adds to the running total).
            const overReservedMicros = held.reservation.reservedMicros - res.costMicros;
            if (overReservedMicros !== 0) {
              await held.hook.spendCaps.release(held.reservation.key, overReservedMicros);
            }
          }
          succeeded = true;
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
          if (providerError.retryable) {
            // Only transient failures (5xx, 429, timeout, network) count
            // toward opening the breaker. A non retryable 4xx is the
            // caller's bad request; it still meters and fails over but must
            // not open the shared breaker for every other workspace.
            await breaker.recordFailure(providerName);
          }
          if (!providerError.retryable || attemptIndex === retry.retries) {
            errors.push(providerError);
            movedOn = true;
          } else {
            await sleep(backoffDelayMs(attemptIndex, retry, random));
          }
        }
      }
    } finally {
      if (!succeeded) {
        for (const held of reservations) {
          if (held.reservation.reservedMicros !== 0) {
            await held.hook.spendCaps.release(held.reservation.key, held.reservation.reservedMicros);
          }
        }
      }
    }
  }

  throw new AllProvidersFailedError(req.task, errors);
}
