/**
 * callWithFailover: the single entry point for every provider call in Curvi
 * (CLAUDE.md rule 4). Walks the ordered failover chain for the request's
 * task and, per provider: skips it when the circuit breaker is open,
 * enforces a timeout with AbortController plus Promise.race, retries with
 * exponential backoff and jitter, meters every attempt (ok and failed),
 * and records breaker successes always but breaker failures only for
 * retryable, transient errors (5xx, 429, timeout, network); a caller's non
 * retryable 4xx or a content block must never open the shared breaker for
 * everyone.
 *
 * Timeouts: the per attempt timeout is req.timeoutMs, else opts.timeoutMs,
 * else DEFAULT_TIMEOUT_MS, raised to the provider's minTimeoutMs (an async
 * job adapter's polling window plus margin) when that is longer.
 *
 * Billed failures: an adapter reports accepted billable work through the
 * request's onBilled hook (for example right after an async job create) or
 * throws a ProviderError with billedCostMicros (for example a refusal whose
 * tokens were billed). The router meters that cost on the failed attempt,
 * keeps it against the spend caps, and never retries the same provider after
 * a reported billed create, since a retry would pay for another generation.
 * The chain still fails over to the next provider.
 *
 * Cost controls, enforced before each invoke:
 * - opts.maxCostMicros rejects a provider whose estimated cost exceeds the
 *   ceiling. The guard fails closed: a provider without estimateCostMicros
 *   is rejected with a hard non retryable ProviderError instead of silently
 *   proceeding uncapped, unless opts.allowUnestimatedCost is explicitly true.
 *   An estimate that throws or is not a finite, non negative number refuses
 *   that provider and the chain moves on.
 * - opts.caps wires the call into the SpendCaps module: the provider's
 *   estimated cost is reserved with the matching checkAndReserve before
 *   invoke, reconciled to the actual cost on success, and reconciled to the
 *   billed cost (zero unless an attempt was billed) when the provider
 *   ultimately fails. A blocked reservation is a non retryable ProviderError
 *   for that provider; a reservation that throws releases the layers already
 *   held and refuses the provider with CapStoreUnavailableError (fail
 *   closed). An allowed global_day reservation at or past the alert line
 *   calls opts.onCapAlert.
 *
 * Once a provider call succeeds, bookkeeping (meter, breaker, reconcile)
 * can no longer trigger a retry or a second release: its errors go to
 * opts.onInternalError.
 *
 * When the whole chain fails it throws AllProvidersFailedError carrying
 * every ProviderError and the chain's billed total. A call that succeeds
 * after billed failures reports that total as CallResult.billedFailureMicros,
 * so callers can book what the caps hold (billedMicrosOf reads a failure).
 */

import { CircuitBreaker } from "./breaker";
import type { CapReservation, SpendCaps } from "./caps";
import type { ProviderRegistry, RoutingTable } from "./registry";
import {
  AllProvidersFailedError,
  BreakerOpenError,
  CapStoreUnavailableError,
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
 * plus an AbortSignal that fires when the router's timeout elapses, and a
 * billing hook. Adapters should pass the signal to fetch. Additive, does not
 * break ProviderRequest. A provider that wraps another one (a bridge) should
 * spread the request it received into the inner call so both reach it. */
export interface RoutedProviderRequest<TIn = unknown> extends ProviderRequest<TIn> {
  signal?: AbortSignal;
  /**
   * Set by the router on every attempt. Adapters call it (through
   * reportBilled in adapters/shared) as soon as the provider has accepted
   * billable work that a retry would pay for again, for example an async job
   * create. Any failure of the attempt after that point is metered at the
   * reported cost, kept against the spend caps and not retried on the same
   * provider. Several calls in one attempt add up.
   */
  onBilled?: (costMicros: number) => void;
}

/** Providers may report an estimated cost so the router can reject a call
 * before invoking when opts.maxCostMicros would be exceeded, and so the
 * caps hook knows how much to reserve. Additive extension, does not break
 * Provider. Every adapter in src/adapters implements this. */
export interface CostAwareProvider extends Provider {
  estimateCostMicros?(req: ProviderRequest): number | Promise<number>;
  /**
   * The shortest per attempt timeout this provider needs, for example an
   * async job adapter's polling window plus a margin. The router never
   * aborts an attempt on this provider sooner, whatever timeout the caller
   * asked for, so a paid job is not abandoned halfway through its polling.
   */
  readonly minTimeoutMs?: number;
}

/** The per attempt timeout the router applies to provider: the requested
 * timeout, raised to the provider's minTimeoutMs when that is longer. */
export function effectiveTimeoutMs(provider: Provider, requestedMs: number): number {
  const floor = (provider as CostAwareProvider).minTimeoutMs;
  return typeof floor === "number" && Number.isFinite(floor) && floor > requestedMs ? floor : requestedMs;
}

/** Which SpendCaps counter a routed call reserves against. */
export type CapKind = "image_asset" | "video_asset" | "pack" | "workspace_day" | "global_day";

/**
 * Wires a routed call into the SpendCaps module. When present on
 * CallWithFailoverOptions the router runs the matching checkAndReserve with
 * the provider's estimated cost before invoking, reconciles the reservation
 * to the actual metered cost after success (adding the shortfall when the
 * call cost more than estimated) and, when the provider fails, reconciles it
 * to what the failed attempts were billed (usually zero, a full release).
 * Identifier fields fall back to the request's own stepId, jobId and
 * workspaceId.
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
  /**
   * billedCostMicros is set when the attempt had already reported billable
   * work (an accepted async job) before the timeout: the error is then not
   * retryable, since a retry would pay for another generation, and the cost
   * is metered.
   */
  constructor(provider: string, task: string, timeoutMs: number, billedCostMicros = 0) {
    const billed = billedCostMicros > 0;
    super(
      billed
        ? `Provider ${provider} timed out after ${timeoutMs}ms after accepting a billed job; not retrying it`
        : `Provider ${provider} timed out after ${timeoutMs}ms`,
      provider,
      task,
      !billed,
      undefined,
      { code: "timeout", billedCostMicros, transient: true },
    );
    this.name = "ProviderTimeoutError";
  }
}

/** RouteOptions plus the caps hooks and injectable effects for tests. */
export interface CallWithFailoverOptions extends RouteOptions {
  /** Reserve against SpendCaps before invoke; see CapsHook. An array layers
   * several caps (for example pack plus global day): every layer must allow
   * the call, and a blocked layer releases the ones already reserved. */
  caps?: CapsHook | CapsHook[];
  /**
   * Called with the global daily running total in USD micros when a
   * global_day caps layer allows a reservation at or past the alert line
   * (plan 4.4), and when charging a call's shortfall moves the total there.
   * Fires on every such call; dedupe in the notifier, for example with
   * SpendCaps.claimGlobalDayAlert. Not awaited, and its errors go to
   * onInternalError, so a slow or failing notifier never blocks a call.
   */
  onCapAlert?: (globalDayTotalMicros: number) => void | Promise<void>;
  /**
   * Receives errors the router swallows so they cannot turn a paid success
   * into a retry or a double release: meter writes, breaker writes,
   * reservation releases and the onCapAlert callback. Wire it to Sentry.
   * Defaults to console.error.
   */
  onInternalError?: (err: unknown, context: string) => void;
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

function defaultInternalError(err: unknown, context: string): void {
  console.error(`[ai] ${context}:`, err);
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
async function reserveForCaps(caps: CapsHook, req: ProviderRequest, costMicros: number): Promise<CapReservation> {
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

/**
 * Merges the attempt's reported billing into its failure. A failure after
 * the provider accepted billable work is not retryable on the same provider
 * and carries the billed cost. An adapter that already put at least that
 * much on the error keeps its own decision.
 */
function withReportedBilling(err: ProviderError, reportedMicros: number, timeoutMs: number): ProviderError {
  if (reportedMicros <= err.billedCostMicros) return err;
  if (err instanceof ProviderTimeoutError) {
    return new ProviderTimeoutError(err.provider, err.task, timeoutMs, reportedMicros);
  }
  return new ProviderError(
    `${err.message} (after the provider accepted a billed job; not retrying it)`,
    err.provider,
    err.task,
    false,
    err,
    { code: err.code, billedCostMicros: reportedMicros, transient: err.transient },
  );
}

async function invokeWithTimeout<TIn, TOut>(
  provider: Provider,
  req: ProviderRequest<TIn>,
  timeoutMs: number,
): Promise<{ output: TOut; costMicros: number }> {
  const controller = new AbortController();
  let reportedMicros = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new ProviderTimeoutError(provider.name, req.task, timeoutMs);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });
  const routed: RoutedProviderRequest<TIn> = {
    ...req,
    signal: controller.signal,
    onBilled: (costMicros: number) => {
      if (Number.isFinite(costMicros) && costMicros > 0) reportedMicros += costMicros;
    },
  };
  try {
    const invocation = Promise.resolve().then(() => provider.invoke<TIn, TOut>(routed));
    // A provider that loses the race may still reject later; mark it handled
    // so it never surfaces as an unhandled rejection.
    invocation.catch(() => {});
    return await Promise.race([invocation, timeout]);
  } catch (err) {
    throw withReportedBilling(toProviderError(err, provider.name, req.task), Math.ceil(reportedMicros), timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

interface HeldReservation {
  hook: CapsHook;
  reservation: CapReservation;
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
  const requestedTimeoutMs = req.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const reportInternal = (err: unknown, context: string): void => {
    try {
      (opts.onInternalError ?? defaultInternalError)(err, context);
    } catch {
      // A failing error reporter must not change the call's outcome either.
    }
  };

  /** Runs bookkeeping that must never change the call's outcome. */
  const safely = async (context: string, effect: () => unknown): Promise<void> => {
    try {
      await effect();
    } catch (err) {
      reportInternal(err, context);
    }
  };

  const fireCapAlert = (totalMicros: number): void => {
    const onCapAlert = opts.onCapAlert;
    if (!onCapAlert) return;
    try {
      const pending = onCapAlert(totalMicros);
      if (pending instanceof Promise) {
        pending.catch((err: unknown) => reportInternal(err, "onCapAlert"));
      }
    } catch (err) {
      reportInternal(err, "onCapAlert");
    }
  };

  /**
   * Moves every held reservation from its reserved amount to spentMicros:
   * releases the over reserved part, or charges the shortfall (a release of
   * a negative amount adds to the total). Runs exactly once per provider.
   * Each layer settles on its own, so one failing release cannot skip the
   * others, and it is reported rather than retried as a full release.
   */
  const settle = async (held: HeldReservation[], alerted: boolean, spentMicros: number): Promise<void> => {
    for (const { hook, reservation } of held) {
      const deltaMicros = reservation.reservedMicros - spentMicros;
      if (deltaMicros === 0) continue;
      await safely(`release ${reservation.key}`, async () => {
        const total = await hook.spendCaps.release(reservation.key, deltaMicros);
        if (
          deltaMicros < 0 &&
          !alerted &&
          hook.capKind === "global_day" &&
          hook.spendCaps.globalDayAlertReached(total)
        ) {
          fireCapAlert(total);
        }
      });
    }
  };

  const startedAt = now();
  const errors: ProviderError[] = [];
  let attempts = 0;
  // Billed spend of every failed attempt across the whole chain, reported to
  // the caller on success (billedFailureMicros) and on failure
  // (AllProvidersFailedError.billedCostMicros).
  let chainBilledMicros = 0;

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
    // closed with a hard ProviderError, never a silent uncapped pass, and a
    // broken estimate refuses this provider without aborting the chain.
    const needsEstimate = opts.maxCostMicros !== undefined || capsHooks.length > 0;
    let estimateMicros: number | undefined;
    if (needsEstimate) {
      if (typeof provider.estimateCostMicros === "function") {
        let estimated: number;
        try {
          estimated = await provider.estimateCostMicros(req);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          errors.push(
            new ProviderError(`Cost estimate failed for "${providerName}": ${detail}`, providerName, req.task, false, err, {
              code: "estimate_failed",
            }),
          );
          continue;
        }
        if (typeof estimated !== "number" || !Number.isFinite(estimated) || estimated < 0) {
          errors.push(
            new ProviderError(
              `Cost estimate for "${providerName}" is not a finite, non negative number: ${String(estimated)}`,
              providerName,
              req.task,
              false,
              undefined,
              { code: "estimate_failed" },
            ),
          );
          continue;
        }
        estimateMicros = estimated;
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
    // A blocked or failing layer releases the layers already reserved and
    // refuses this provider; the chain moves on.
    const held: HeldReservation[] = [];
    const alertTotals: number[] = [];
    let refusal: ProviderError | undefined;
    for (const hook of capsHooks) {
      let reservation: CapReservation;
      try {
        reservation = await reserveForCaps(hook, req, estimateMicros ?? 0);
      } catch (err) {
        refusal = new CapStoreUnavailableError(providerName, req.task, err);
        break;
      }
      if (!reservation.allowed) {
        refusal = new ProviderError(
          `Spend cap blocked call: ${reservation.reason ?? `over cap of ${reservation.capMicros} micros`}`,
          providerName,
          req.task,
          false,
          undefined,
          { code: "cap_blocked" },
        );
        break;
      }
      held.push({ hook, reservation });
      if (hook.capKind === "global_day" && reservation.alert) {
        alertTotals.push(reservation.totalMicros);
      }
    }
    if (refusal) {
      await settle(held, true, 0);
      errors.push(refusal);
      continue;
    }
    // Alert only once every layer allowed the reservation.
    for (const total of alertTotals) {
      fireCapAlert(total);
    }
    const alerted = alertTotals.length > 0;

    const timeoutMs = effectiveTimeoutMs(provider, requestedTimeoutMs);
    // Spend billed on this provider's failed attempts, kept against the caps.
    let billedMicros = 0;
    let settled = false;
    try {
      for (let attemptIndex = 0; attemptIndex <= retry.retries; attemptIndex++) {
        attempts += 1;
        const attemptStart = now();
        let res: { output: TOut; costMicros: number };
        try {
          res = await invokeWithTimeout<TIn, TOut>(provider, req, timeoutMs);
        } catch (err) {
          const providerError = toProviderError(err, providerName, req.task);
          // A content block is never retried, whatever the adapter said:
          // the same prompt gets the same answer and costs another attempt.
          const retryable = providerError.retryable && providerError.code !== "content_blocked";
          const latencyMs = now() - attemptStart;
          billedMicros += providerError.billedCostMicros;
          chainBilledMicros += providerError.billedCostMicros;
          await safely("meter.record failure", () =>
            meter.record({
              provider: providerName,
              task: req.task,
              costMicros: providerError.billedCostMicros,
              latencyMs,
              ok: false,
              error: providerError.message,
              errorCode: providerError.code,
              workspaceId: req.workspaceId,
              jobId: req.jobId,
              stepId: req.stepId,
              attempt: attempts,
              at: new Date(),
            }),
          );
          if (providerError.transient) {
            // Only transient failures (5xx, 429, timeout, network, a stalled
            // job) count toward opening the breaker, including a billed one
            // that is no longer retried. A non retryable 4xx or a content
            // block is about this caller's request; it still meters and
            // fails over but must not open the shared breaker for every
            // other workspace.
            await safely("breaker.recordFailure", () => breaker.recordFailure(providerName));
          }
          if (!retryable || attemptIndex === retry.retries) {
            errors.push(providerError);
            break;
          }
          await sleep(backoffDelayMs(attemptIndex, retry, random));
          continue;
        }

        // The provider delivered and was paid. From here on nothing may
        // retry it or release the reservation in full: bookkeeping errors
        // are reported, never rethrown.
        settled = true;
        const latencyMs = now() - attemptStart;
        await safely("meter.record success", () =>
          meter.record({
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
          }),
        );
        await safely("breaker.recordSuccess", () => breaker.recordSuccess(providerName));
        await settle(held, alerted, billedMicros + res.costMicros);
        return {
          output: res.output,
          costMicros: res.costMicros,
          provider: providerName,
          attempts,
          latencyMs: now() - startedAt,
          billedFailureMicros: chainBilledMicros,
        };
      }
    } finally {
      if (!settled) {
        settled = true;
        await settle(held, alerted, billedMicros);
      }
    }
  }

  throw new AllProvidersFailedError(req.task, errors, chainBilledMicros);
}
