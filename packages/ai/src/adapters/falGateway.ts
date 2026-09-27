/**
 * fal.ai queue gateway adapter, the generic secondary route for image and
 * video models (POST {baseUrl}/{modelId} with an Authorization "Key" header,
 * then polling status_url until COMPLETED and fetching response_url). The
 * fal model ID, provider kind and per call price are constructor parameters,
 * so one class covers any fal hosted model.
 *
 * VERIFY AT FIRST LIVE CALL: queue response field names (request_id,
 * status_url, response_url), status values (IN_QUEUE, IN_PROGRESS,
 * COMPLETED) and per model output shapes against https://docs.fal.ai.
 * Unit tests cover construction and supports() only.
 */

import { ProviderError } from "../types";
import type { Provider, ProviderKind, ProviderRequest, ProviderResponse } from "../types";
import { requestJson, resolveApiKey, signalOf, sleepMs, type AdapterCommonConfig, type FetchLike } from "./shared";

export const FAL_API_KEY_ENV = "FAL_KEY";

export interface FalGatewayConfig extends AdapterCommonConfig {
  /** fal model ID from seed data, e.g. an image or video model path. */
  modelId: string;
  /** What this route serves; fal hosts several modalities. */
  kind: ProviderKind;
  priceTable: { perCallMicros: number };
  pollIntervalMs?: number;
  maxPolls?: number;
}

/** Input is passed through to the fal model as the request body. */
export type FalGatewayInput = Record<string, unknown>;

export interface FalGatewayOutput {
  /** The model's response payload, shape depends on the fal model. */
  result: unknown;
}

interface QueueResponse {
  request_id?: string;
  status_url?: string;
  response_url?: string;
}

interface StatusResponse {
  status?: string;
}

export class FalGatewayProvider implements Provider {
  readonly name: string;
  readonly kind: ProviderKind;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly tasks: string[];
  private readonly modelId: string;
  private readonly priceTable: { perCallMicros: number };
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;

  constructor(config: FalGatewayConfig) {
    this.name = config.name;
    this.kind = config.kind;
    this.tasks = config.tasks;
    this.apiKey = resolveApiKey(config.name, config.apiKey, FAL_API_KEY_ENV);
    this.baseUrl = config.baseUrl ?? "https://queue.fal.run";
    this.fetchFn = config.fetchFn ?? fetch;
    this.modelId = config.modelId;
    this.priceTable = config.priceTable;
    this.pollIntervalMs = config.pollIntervalMs ?? 1000;
    this.maxPolls = config.maxPolls ?? 300;
  }

  supports(task: string): boolean {
    return this.tasks.includes(task);
  }

  async invoke<TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    const signal = signalOf(req);
    const headers = { authorization: `Key ${this.apiKey}`, "content-type": "application/json" };

    const queued = await requestJson<QueueResponse>(
      this.fetchFn,
      this.name,
      req.task,
      `${this.baseUrl}/${this.modelId}`,
      { method: "POST", headers, body: JSON.stringify(req.input ?? {}), signal },
    );
    if (!queued.status_url || !queued.response_url) {
      throw new ProviderError("fal queue response missing status_url or response_url", this.name, req.task, true);
    }

    for (let poll = 0; poll < this.maxPolls; poll++) {
      await sleepMs(this.pollIntervalMs, signal);
      const state = await requestJson<StatusResponse>(this.fetchFn, this.name, req.task, queued.status_url, {
        method: "GET",
        headers,
        signal,
      });
      if (state.status === "COMPLETED") {
        const result = await requestJson<unknown>(this.fetchFn, this.name, req.task, queued.response_url, {
          method: "GET",
          headers,
          signal,
        });
        const output: FalGatewayOutput = { result };
        return { output: output as TOut, costMicros: this.priceTable.perCallMicros };
      }
      if (state.status !== undefined && state.status !== "IN_QUEUE" && state.status !== "IN_PROGRESS") {
        throw new ProviderError(`fal request ended with status ${state.status}`, this.name, req.task, false);
      }
    }
    throw new ProviderError("fal polling exceeded maxPolls without a result", this.name, req.task, true);
  }
}
