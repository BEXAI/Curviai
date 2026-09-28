/**
 * Test doubles for the AI abstraction layer, importable as
 * "@curvi/ai/testing". Nothing here touches the network.
 */

import type { CostAwareProvider, RoutedProviderRequest } from "../router";
import type { ProviderKind, ProviderRequest, ProviderResponse } from "../types";
import { ProviderError } from "../types";

export { InMemoryBreakerStore } from "../breaker";
export { InMemoryCostMeter } from "../meter";
export { InMemoryCapStore } from "../caps";

export interface MockProviderConfig {
  name: string;
  kind?: ProviderKind;
  /** Tasks supports() accepts. Omit to accept every task. */
  tasks?: string[];
  /** Fixed output returned on success. */
  output?: unknown;
  /** Cost reported per successful call, in USD micros. */
  costMicros?: number;
  /** Fail this many calls before succeeding. Infinity fails forever. */
  failTimes?: number;
  /** Error factory for failures. Defaults to a retryable ProviderError. */
  failWith?: (attempt: number) => Error;
  /** Artificial latency per call, real timers. */
  latencyMs?: number;
  /**
   * Hang this many calls: the invoke promise never settles unless the
   * router's abort signal fires, which rejects it. Use with a short timeout
   * to exercise the timeout and retry path.
   */
  hangTimes?: number;
  /** When set, the provider exposes estimateCostMicros returning this. */
  estimateMicros?: number;
  /** When set, the provider exposes estimateCostMicros calling this; it may
   * throw to exercise a broken estimate. Wins over estimateMicros. */
  estimate?: (req: ProviderRequest) => number;
  /**
   * Simulates an async job create that was accepted and paid for: every
   * call reports this cost through the router's billing hook before it
   * hangs, fails or succeeds.
   */
  reportBilledMicros?: number;
  /** Exposed as the provider's minTimeoutMs. */
  minTimeoutMs?: number;
}

export class MockProvider implements CostAwareProvider {
  readonly name: string;
  readonly kind: ProviderKind;
  /** Every request passed to invoke, in order. */
  readonly calls: ProviderRequest[] = [];
  /** Number of invoke calls so far. */
  invocations = 0;

  estimateCostMicros?: (req: ProviderRequest) => number;
  readonly minTimeoutMs: number | undefined;

  constructor(private readonly config: MockProviderConfig) {
    this.name = config.name;
    this.kind = config.kind ?? "llm";
    this.minTimeoutMs = config.minTimeoutMs;
    if (config.estimate !== undefined) {
      this.estimateCostMicros = config.estimate;
    } else if (config.estimateMicros !== undefined) {
      const estimate = config.estimateMicros;
      this.estimateCostMicros = () => estimate;
    }
  }

  supports(task: string): boolean {
    return this.config.tasks ? this.config.tasks.includes(task) : true;
  }

  async invoke<TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    this.invocations += 1;
    const call = this.invocations;
    this.calls.push(req);

    if (this.config.reportBilledMicros !== undefined) {
      (req as RoutedProviderRequest<TIn>).onBilled?.(this.config.reportBilledMicros);
    }

    if (this.config.latencyMs) {
      await new Promise((resolve) => setTimeout(resolve, this.config.latencyMs));
    }

    if (this.config.hangTimes !== undefined && call <= this.config.hangTimes) {
      const signal = (req as RoutedProviderRequest<TIn>).signal;
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
      });
    }

    if (this.config.failTimes !== undefined && call <= this.config.failTimes) {
      const make = this.config.failWith;
      throw make
        ? make(call)
        : new ProviderError(`mock failure ${call}`, this.name, req.task, true);
    }

    return {
      output: (this.config.output ?? { mock: true }) as TOut,
      costMicros: this.config.costMicros ?? 0,
    };
  }
}
