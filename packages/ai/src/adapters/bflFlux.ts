/**
 * Black Forest Labs FLUX adapter (POST {baseUrl}/v1/{model} with the x-key
 * header, then polling the returned polling_url until the result is Ready).
 * The model path segment, e.g. "flux-2-pro", and the per image price are
 * constructor parameters.
 *
 * VERIFY AT FIRST LIVE CALL: the create endpoint path for the current FLUX 2
 * pro model, the polling_url response contract, terminal status names
 * (Ready, Error, Content Moderated) and the result.sample field against
 * https://docs.bfl.ai. Unit tests cover construction and supports() only.
 */

import { ProviderError } from "../types";
import type { Provider, ProviderKind, ProviderRequest, ProviderResponse } from "../types";
import { requestJson, resolveApiKey, signalOf, sleepMs, type AdapterCommonConfig, type FetchLike } from "./shared";

export const BFL_API_KEY_ENV = "BFL_API_KEY";

export interface BflFluxConfig extends AdapterCommonConfig {
  /** Model path segment from seed data, e.g. "flux-2-pro". */
  model: string;
  priceTable: { perImageMicros: number };
  pollIntervalMs?: number;
  /** Safety cap on polling attempts; the router timeout also applies. */
  maxPolls?: number;
}

export interface BflFluxInput {
  prompt: string;
  width?: number;
  height?: number;
  /** Base64 reference image for image to image edits. */
  inputImageBase64?: string;
  seed?: number;
}

export interface BflFluxOutput {
  /** Signed URL of the generated image; download promptly, BFL URLs expire. */
  imageUrl: string;
  raw: unknown;
}

interface CreateResponse {
  id?: string;
  polling_url?: string;
}

interface PollResponse {
  status?: string;
  result?: { sample?: string };
}

export class BflFluxProvider implements Provider {
  readonly name: string;
  readonly kind: ProviderKind = "image";

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly tasks: string[];
  private readonly model: string;
  private readonly priceTable: { perImageMicros: number };
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;

  constructor(config: BflFluxConfig) {
    this.name = config.name;
    this.tasks = config.tasks;
    this.apiKey = resolveApiKey(config.name, config.apiKey, BFL_API_KEY_ENV);
    this.baseUrl = config.baseUrl ?? "https://api.bfl.ai";
    this.fetchFn = config.fetchFn ?? fetch;
    this.model = config.model;
    this.priceTable = config.priceTable;
    this.pollIntervalMs = config.pollIntervalMs ?? 500;
    this.maxPolls = config.maxPolls ?? 240;
  }

  supports(task: string): boolean {
    return this.tasks.includes(task);
  }

  async invoke<TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    const input = req.input as unknown as BflFluxInput;
    const signal = signalOf(req);
    const body: Record<string, unknown> = { prompt: input.prompt };
    if (input.width !== undefined) body.width = input.width;
    if (input.height !== undefined) body.height = input.height;
    if (input.inputImageBase64 !== undefined) body.input_image = input.inputImageBase64;
    if (input.seed !== undefined) body.seed = input.seed;

    const created = await requestJson<CreateResponse>(
      this.fetchFn,
      this.name,
      req.task,
      `${this.baseUrl}/v1/${this.model}`,
      {
        method: "POST",
        headers: { "x-key": this.apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!created.polling_url) {
      throw new ProviderError("BFL create response had no polling_url", this.name, req.task, true);
    }

    for (let poll = 0; poll < this.maxPolls; poll++) {
      await sleepMs(this.pollIntervalMs, signal);
      const state = await requestJson<PollResponse>(this.fetchFn, this.name, req.task, created.polling_url, {
        method: "GET",
        headers: { "x-key": this.apiKey },
        signal,
      });
      if (state.status === "Ready") {
        const imageUrl = state.result?.sample;
        if (!imageUrl) {
          throw new ProviderError("BFL Ready result had no sample URL", this.name, req.task, true);
        }
        const output: BflFluxOutput = { imageUrl, raw: state };
        return { output: output as TOut, costMicros: this.priceTable.perImageMicros };
      }
      if (state.status === "Error" || state.status === "Content Moderated" || state.status === "Request Moderated") {
        throw new ProviderError(`BFL generation failed with status ${state.status}`, this.name, req.task, false);
      }
    }
    throw new ProviderError("BFL polling exceeded maxPolls without a result", this.name, req.task, true);
  }
}
