/**
 * PLACEHOLDER for the OpenAI LLM adapter (docs/phases/PHASE_17.md workstream
 * 2), which is built on its own branch. This file only gives the workstream 3
 * wiring (trigger/src/live-runtime.ts, provider-probes.ts) the class name and
 * config it imports, so that branch typechecks and tests on its own. The
 * integrator replaces this whole file with the real adapter.
 *
 * It never calls the network: invoke fails closed with a non retryable error,
 * so a chain that reaches it moves on to the next model.
 */

import type { ProbeOptions, ProbeResult } from "../probe";
import type { CostAwareProvider } from "../router";
import { ProviderError, type ProviderKind, type ProviderRequest, type ProviderResponse } from "../types";
import type { AdapterCommonConfig } from "./shared";

export interface OpenaiLLMPriceTable {
  inputMicrosPerMTok: number;
  cachedInputMicrosPerMTok?: number;
  outputMicrosPerMTok: number;
}

export interface OpenaiLLMConfig extends AdapterCommonConfig {
  model: string;
  priceTable: OpenaiLLMPriceTable;
  /** Image token multiplier for the cap estimate (seed data). */
  imageTokenMultiplier: number;
}

export class OpenaiLLMProvider implements CostAwareProvider {
  readonly name: string;
  readonly kind: ProviderKind = "llm";
  readonly model: string;
  readonly minTimeoutMs: number | undefined;
  private readonly tasks: string[];

  constructor(config: OpenaiLLMConfig) {
    this.name = config.name;
    this.tasks = config.tasks;
    this.model = config.model;
    this.minTimeoutMs = config.minTimeoutMs;
  }

  supports(task: string): boolean {
    return this.tasks.includes(task);
  }

  probe(_options?: ProbeOptions): Promise<ProbeResult> {
    return Promise.resolve({ ok: false, status: null, latencyMs: 0, skipped: "The OpenAI LLM adapter is not built on this branch." });
  }

  invoke<TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    return Promise.reject(
      new ProviderError("The OpenAI LLM adapter is not built on this branch.", this.name, req.task, false),
    );
  }
}
